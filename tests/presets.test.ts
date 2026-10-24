import { describe, expect, it } from 'vitest';
import { createEffect } from '../src/engine/post/effects';
import { BUILTIN_PRESETS } from '../src/engine/presets/builtins';
import { addPreset, duplicatePreset, importPresets, MAX_USER_PRESETS, removePreset, renamePreset, updatePreset } from '../src/engine/presets/library';
import {
  decodePresetFromUrl,
  encodePresetForUrl,
  exampleZoomBinding,
  makePreset,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_PRESETS,
  MAX_URL_PAYLOAD,
  migratePreset,
  PRESET_SCHEMA,
  presetBackupFiles,
  presetsFromFile,
  presetsFromJson,
  presetToJson,
  presetValues,
} from '../src/engine/presets/schema';
import { createBinding } from '../src/engine/modulation';

const NOW = 1_700_000_000_000;

function sample() {
  const bloom = createEffect('bloom', 'fx-bloom');
  return makePreset({
    sceneId: 'cosmic-rings',
    name: 'Halo test',
    values: { rings: 20, zoom: 1.4, primary: '#ff0055', fov: 50 },
    modulations: [exampleZoomBinding(), { ...createBinding('fx:fx-bloom:intensity', 'kick', 'm-fx'), amount: 0.5 }],
    post: [bloom, createEffect('vignette', 'fx-vig')],
    now: NOW,
  });
}

describe('preset schema', () => {
  it('contains scene, params, colours, camera, modulation, post stack and schema version', () => {
    const p = sample();
    expect(p.schema).toBe(PRESET_SCHEMA);
    expect(p.sceneId).toBe('cosmic-rings');
    expect(p.params.rings).toBe(20);
    expect(p.colors.primary).toBe('#ff0055');
    expect(p.camera.zoom).toBe(1.4);
    expect(p.camera.fov).toBe(50);
    expect(p.modulations).toHaveLength(2);
    expect(p.post.map((e) => e.type)).toEqual(['bloom', 'vignette']);
  });

  it('survives a save → load round trip unchanged', () => {
    const p = sample();
    const res = migratePreset(JSON.parse(JSON.stringify(p)), NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.migratedFrom).toBe(PRESET_SCHEMA);
      expect(res.preset).toEqual(p);
    }
  });

  it('migrates BEAT//FORM 1.0 settings objects', () => {
    const res = migratePreset({ mode: 'radial', accent: '#00ffaa', background: '#000000', bassSensitivity: 1.8, smoothing: 0.7, beatImpact: 1.2 }, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.migratedFrom).toBe(1);
    expect(res.preset.sceneId).toBe('radial-spectrum');
    expect(res.preset.colors.primary).toBe('#00ffaa');
    expect(res.preset.params.bass).toBe(1.8);
    expect(res.preset.params.smoothing).toBe(0.7);
  });

  it('rejects newer schemas and garbage instead of guessing', () => {
    expect(migratePreset({ schema: 99, sceneId: 'pulse-object' }).ok).toBe(false);
    expect(migratePreset('preset').ok).toBe(false);
    expect(migratePreset([]).ok).toBe(false);
    expect(migratePreset({ schema: 1.5 }).ok).toBe(false);
    expect(migratePreset({ hello: 'world' }).ok).toBe(false);
  });

  it('sanitises hostile content', () => {
    const res = migratePreset(
      {
        schema: 2,
        sceneId: 'does-not-exist',
        name: '<img src=x onerror=alert(1)>' + 'x'.repeat(500),
        params: { scale: 1e9, zoom: 'NaN' },
        colors: { primary: 'url(javascript:1)' },
        modulations: [{ id: 'a', target: 'not-a-param', source: 'bass' }, { id: 'b', target: 'fx:ghost:intensity', source: 'kick' }, { id: 'c', target: 'zoom', source: 'bass' }],
        post: [{ type: 'bloom', id: 'fx-1', enabled: true, params: { intensity: 1e6 } }, { type: 'evil' }],
      },
      NOW,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.preset;
    expect(p.sceneId).toBe('pulse-object');
    expect(p.name).not.toMatch(/[<>]/);
    expect(p.name.length).toBeLessThanOrEqual(60);
    expect(p.colors.primary).toMatch(/^#[0-9a-f]{6}$/i);
    expect(p.modulations.map((m) => m.id)).toEqual(['c']);
    expect(p.post).toHaveLength(1);
    expect(p.post[0].params.intensity).toBeLessThanOrEqual(4);
    const values = presetValues(p);
    expect(values.scale).toBeLessThanOrEqual(2.5);
  });

  it('round-trips JSON export / import with fresh ids', () => {
    const a = sample();
    const json = presetToJson([a, BUILTIN_PRESETS[0]]);
    const { presets, errors } = presetsFromJson(json, NOW);
    expect(errors).toEqual([]);
    expect(presets).toHaveLength(2);
    expect(presets[0].id).not.toBe(a.id);
    expect(presets[0].builtIn).toBeUndefined();
    expect(presets[0].params).toEqual(a.params);
    expect(presets[0].modulations).toEqual(a.modulations);
    expect(presetsFromJson('{nope', NOW).errors).toEqual(['NOT VALID JSON']);
    expect(presetsFromJson('x'.repeat(600 * 1024), NOW).presets).toEqual([]);
    const many = JSON.stringify(Array.from({ length: MAX_IMPORT_PRESETS + 5 }, () => a));
    expect(presetsFromJson(many, NOW).presets).toHaveLength(MAX_IMPORT_PRESETS);
  });
});

describe('preset share links', () => {
  it('round-trips through a compact URL-safe payload with no audio', () => {
    const p = sample();
    const enc = encodePresetForUrl(p);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(enc.length).toBeLessThan(MAX_URL_PAYLOAD);
    expect(enc.length).toBeLessThan(2000);
    const decoded = JSON.parse(Buffer.from(enc, 'base64url').toString('utf8'));
    expect(Object.keys(decoded).sort()).toEqual(['camera', 'colors', 'modulations', 'name', 'params', 'post', 'schema', 'sceneId'].sort());
    const res = decodePresetFromUrl(enc, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(presetValues(res.preset)).toEqual(presetValues(p));
    expect(res.preset.modulations).toEqual(p.modulations);
    expect(res.preset.post).toEqual(p.post);
  });

  it('rejects malformed, oversized and future links', () => {
    expect(decodePresetFromUrl('').ok).toBe(false);
    expect(decodePresetFromUrl('a'.repeat(MAX_URL_PAYLOAD + 1)).ok).toBe(false);
    expect(decodePresetFromUrl('not base64!').ok).toBe(false);
    expect(decodePresetFromUrl(Buffer.from('{"schema":7}').toString('base64url')).ok).toBe(false);
  });

  it('refuses to encode a preset that would make an over-long link', () => {
    const p = sample();
    p.name = 'x';
    p.modulations = Array.from({ length: 32 }, (_, i) => ({ ...createBinding('zoom', 'bass', `m-${'y'.repeat(60)}-${i}`) }));
    p.post = Array.from({ length: 12 }, (_, i) => createEffect('glitch', `fx-${'z'.repeat(50)}-${i}`));
    expect(() => encodePresetForUrl(p)).toThrow(/TOO LARGE/);
  });
});

describe('preset library', () => {
  it('adds, renames, overwrites, duplicates and deletes', () => {
    const a = sample();
    let list = addPreset([], a);
    list = renamePreset(list, a.id, '  Renamed  ', NOW + 1);
    expect(list[0].name).toBe('Renamed');
    expect(list[0].updatedAt).toBe(NOW + 1);
    const { list: withCopy, copy: maybeCopy } = duplicatePreset(list, list[0], NOW + 2);
    const copy = maybeCopy!;
    expect(withCopy).toHaveLength(2);
    expect(copy.id).not.toBe(a.id);
    expect(copy.name).toMatch(/COPY/i);
    const changed = updatePreset(withCopy, a.id, { ...a, params: { ...a.params, rings: 8 } }, NOW + 3);
    expect(changed.find((p) => p.id === a.id)!.params.rings).toBe(8);
    expect(changed.find((p) => p.id === a.id)!.name).toBe('Renamed');
    expect(removePreset(changed, a.id).map((p) => p.id)).toEqual([copy.id]);
  });

  it('caps the number of user presets without ever pushing one out', () => {
    let list = [] as ReturnType<typeof addPreset>;
    for (let i = 0; i < MAX_USER_PRESETS + 10; i++) list = addPreset(list, { ...sample(), id: `p-${i}` });
    expect(list.length).toBe(MAX_USER_PRESETS);
    expect(list.some((p) => p.id === 'p-0')).toBe(true); // the oldest is still there
    expect(list.some((p) => p.id === `p-${MAX_USER_PRESETS}`)).toBe(false); // the 201st was refused
    expect(duplicatePreset(list, list[0]).copy).toBeNull();
    // replacing an existing preset still works when full
    expect(addPreset(list, { ...list[5], name: 'NEW NAME' }).find((p) => p.id === list[5].id)!.name).toBe('NEW NAME');
  });
});

describe('preset backup of a full library', () => {
  /** The largest preset the schema allows: every modulation slot and effect slot used. */
  function maximalPreset(i: number) {
    const sceneIds = ['pulse-object', 'reactive-mesh', 'cosmic-rings', 'particle-cloud', 'audio-tunnel', 'plasma-flow', 'fractal-bloom', 'radial-spectrum', 'wave-field'];
    const sceneId = sceneIds[i % sceneIds.length];
    const post = Array.from({ length: 12 }, (_, k) => createEffect(['bloom', 'glitch', 'trails', 'kaleidoscope', 'grain', 'vignette'][k % 6] as never, `fx-${String(k).padStart(2, '0')}-${'x'.repeat(34)}` /* 40 chars, the schema maximum */));
    const values: Record<string, number> = {};
    for (const key of ['scale', 'zoom', 'bass', 'mids', 'treble', 'brightness', 'contrast', 'saturation', 'speed', 'rotation']) values[key] = 1.0123456789012345;
    // targets valid in every scene, and one real parameter of each effect type
    const targets = ['bass', 'mids', 'treble', 'subBass', 'kickImpact', 'brightness', 'contrast', 'saturation'];
    const fxParam: Record<string, string> = { bloom: 'intensity', glitch: 'amount', trails: 'persistence', kaleidoscope: 'spin', grain: 'amount', vignette: 'amount' };
    const modulations = Array.from({ length: 32 }, (_, k) => ({
      ...createBinding(k < 8 ? targets[k] : `fx:${post[k % 12].id}:${fxParam[post[k % 12].type]}`, 'lfo', `m-${k}-${'y'.repeat(50)}`),
      amount: -0.123456789,
      attack: 0.0123456789,
      release: 0.3456789012,
      lfoRate: 1.23456789,
    }));
    return makePreset({ sceneId, name: `${'PRESET NAME '.repeat(5)}${i}`.slice(0, 60), values, modulations, post, now: NOW + i });
  }

  it('EXPORT ALL of the largest allowed library restores completely, effects and modulations included', () => {
    const library = Array.from({ length: MAX_USER_PRESETS }, (_, i) => maximalPreset(i));
    const json = presetToJson(library);
    expect(json.length).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
    const { presets, errors } = presetsFromJson(json, NOW);
    expect(errors).toEqual([]);
    expect(presets).toHaveLength(MAX_USER_PRESETS);
    presets.forEach((p, i) => {
      expect(p.name).toBe(library[i].name);
      expect(p.sceneId).toBe(library[i].sceneId);
      expect(presetValues(p)).toEqual(presetValues(library[i]));
      expect(p.post).toEqual(library[i].post);
      expect(p.modulations).toEqual(library[i].modulations);
    });
    // and the restored list fits into the library without pushing anything out
    let list: ReturnType<typeof addPreset> = [];
    for (const p of presets) list = addPreset(list, p);
    expect(list).toHaveLength(MAX_USER_PRESETS);
  });

  it('import limits match the library limits', () => {
    expect(MAX_IMPORT_PRESETS).toBeGreaterThanOrEqual(MAX_USER_PRESETS);
  });
});

describe('importing into an existing library', () => {
  const lib = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ ...makePreset({ sceneId: 'pulse-object', name: `${tag} ${i}`, values: { zoom: 1 + i / 1000 }, now: NOW }), id: `${tag}-${i}` }));

  it('adds in file order on top, never evicts, and reports what did not fit', () => {
    const existing = lib(150, 'OLD');
    const incoming = lib(80, 'NEW');
    const r = importPresets(existing, incoming);
    expect(r.added).toBe(50);
    expect(r.overflow).toBe(30);
    expect(r.list).toHaveLength(MAX_USER_PRESETS);
    expect(r.list.slice(0, 3).map((p) => p.name)).toEqual(['NEW 0', 'NEW 1', 'NEW 2']);
    expect(existing.every((p) => r.list.includes(p))).toBe(true);
  });

  it('restoring the same backup twice does not duplicate presets', () => {
    const backup = presetsFromJson(presetToJson(lib(20, 'B')), NOW).presets;
    const once = importPresets([], backup);
    const twice = importPresets(once.list, presetsFromJson(presetToJson(lib(20, 'B')), NOW).presets);
    expect(twice.added).toBe(0);
    expect(twice.duplicates).toBe(20);
    expect(twice.list).toHaveLength(20);
  });

  it('checks the file size before reading the file', async () => {
    let read = false;
    const huge = { size: MAX_IMPORT_BYTES + 1, text: async () => ((read = true), '[]') };
    const r = await presetsFromFile(huge, NOW);
    expect(read).toBe(false);
    expect(r.presets).toEqual([]);
    expect(r.errors[0]).toMatch(/TOO LARGE/);
    const ok = await presetsFromFile(new Blob([presetToJson(lib(3, 'S'))]), NOW);
    expect(ok.presets).toHaveLength(3);
  });

  it('a backup that would exceed the import limit is split into files that each import', () => {
    const presets = lib(40, 'X');
    const files = presetBackupFiles(presets, 20_000);
    expect(files.length).toBeGreaterThan(1);
    let restored = 0;
    for (const f of files) {
      expect(f.length).toBeLessThanOrEqual(20_000);
      restored += presetsFromJson(f, NOW).presets.length;
    }
    expect(restored).toBe(40);
    expect(presetBackupFiles(presets)).toHaveLength(1); // the real limit fits a whole library
  });
});
