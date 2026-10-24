import { describe, expect, it } from 'vitest';
import { createEffect } from '../src/engine/post/effects';
import { BUILTIN_PRESETS } from '../src/engine/presets/builtins';
import { addPreset, duplicatePreset, MAX_USER_PRESETS, removePreset, renamePreset, updatePreset } from '../src/engine/presets/library';
import {
  decodePresetFromUrl,
  encodePresetForUrl,
  exampleZoomBinding,
  makePreset,
  MAX_IMPORT_PRESETS,
  MAX_URL_PAYLOAD,
  migratePreset,
  PRESET_SCHEMA,
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
    const { list: withCopy, copy } = duplicatePreset(list, list[0], NOW + 2);
    expect(withCopy).toHaveLength(2);
    expect(copy.id).not.toBe(a.id);
    expect(copy.name).toMatch(/COPY/i);
    const changed = updatePreset(withCopy, a.id, { ...a, params: { ...a.params, rings: 8 } }, NOW + 3);
    expect(changed.find((p) => p.id === a.id)!.params.rings).toBe(8);
    expect(changed.find((p) => p.id === a.id)!.name).toBe('Renamed');
    expect(removePreset(changed, a.id).map((p) => p.id)).toEqual([copy.id]);
  });

  it('caps the number of user presets', () => {
    let list = [] as ReturnType<typeof addPreset>;
    for (let i = 0; i < MAX_USER_PRESETS + 10; i++) list = addPreset(list, { ...sample(), id: `p-${i}` });
    expect(list.length).toBe(MAX_USER_PRESETS);
  });
});
