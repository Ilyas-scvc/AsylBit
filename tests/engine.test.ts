import { describe, expect, it } from 'vitest';
import { effectiveFov, fitDistance } from '../src/engine/camera';
import { bandWeights, gateThresholdDb, shapeTransient } from '../src/engine/features';
import { defaultParams, getSceneSchema, sanitizeParam, sanitizeParams, STANDARD_PARAMS } from '../src/engine/params';
import { budgetedEffects, createEffect, EFFECTS, moveEffect, sanitizeStack, MAX_STACK } from '../src/engine/post/effects';
import { BUILTIN_PRESETS } from '../src/engine/presets/builtins';
import { SCENE_FACTORIES } from '../src/engine/scenes/factories';
import { PERFORMANCE_PRESETS, presetFromLegacyQuality, qualityProfile } from '../src/engine/quality';
import { DEFAULT_SCENE_ID, LEGACY_MODE_SCENES, SceneRegistry, getScene, sceneRegistry } from '../src/engine/scenes/registry';
import { SCENE_CATEGORIES, type SceneDefinition } from '../src/engine/types';

describe('scene registry', () => {
  it('registers the three original scenes and the six new ones, in order', () => {
    const ids = sceneRegistry.list().map((s) => s.id);
    expect(ids).toEqual([
      'pulse-object',
      'radial-spectrum',
      'wave-field',
      'reactive-mesh',
      'cosmic-rings',
      'particle-cloud',
      'audio-tunnel',
      'plasma-flow',
      'fractal-bloom',
    ]);
    expect(sceneRegistry.list().map((s) => s.index)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09']);
    expect(sceneRegistry.has(DEFAULT_SCENE_ID)).toBe(true);
  });

  it('maps every legacy 1.0 mode to a registered scene', () => {
    for (const id of Object.values(LEGACY_MODE_SCENES)) expect(sceneRegistry.has(id)).toBe(true);
    expect(LEGACY_MODE_SCENES.pulse).toBe('pulse-object');
  });

  it('gives every scene a complete definition and a valid category', () => {
    const categories = new Set(SCENE_CATEGORIES.map((c) => c.id));
    for (const def of sceneRegistry.list()) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(10);
      expect(categories.has(def.category)).toBe(true);
      expect(typeof SCENE_FACTORIES[def.id]).toBe('function');
      expect(['pulse', 'radial', 'wave']).toContain(def.fallback2D);
    }
  });

  it('filters by category', () => {
    const particles = sceneRegistry.list('particles').map((s) => s.id);
    expect(particles).toContain('particle-cloud');
    expect(particles).not.toContain('plasma-flow');
  });

  it('falls back to the default scene for unknown ids', () => {
    expect(getScene('nope').id).toBe(DEFAULT_SCENE_ID);
  });

  it('rejects duplicate ids and broken schemas', () => {
    const reg = new SceneRegistry();
    const base = sceneRegistry.get('pulse-object')!;
    reg.register(base);
    expect(() => reg.register(base)).toThrow();
    const broken: SceneDefinition = { ...base, id: 'broken', params: [{ key: 'x', label: 'X', group: 'geometry', type: 'number', default: 5, min: 0, max: 1 }] };
    expect(() => reg.register(broken)).toThrow();
  });
});

describe('scene parameter schemas', () => {
  it('has unique keys and defaults inside their ranges for every scene', () => {
    for (const def of sceneRegistry.list()) {
      const schema = getSceneSchema(def);
      const keys = schema.map((d) => d.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const d of schema) {
        if (d.type === 'number') {
          expect(d.default as number).toBeGreaterThanOrEqual(d.min!);
          expect(d.default as number).toBeLessThanOrEqual(d.max!);
        }
        if (d.type === 'select') expect(d.options!.map((o) => o.value)).toContain(d.default);
        if (d.type === 'color') expect(d.default).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('only exposes parameters a scene declares (scene-specific inspector)', () => {
    const plasma = getSceneSchema(getScene('plasma-flow')).map((d) => d.key);
    const mesh = getSceneSchema(getScene('reactive-mesh')).map((d) => d.key);
    expect(mesh).toContain('layout');
    expect(plasma).not.toContain('layout');
    // every scene carries the shared audio + colour controls
    for (const def of sceneRegistry.list()) {
      const keys = getSceneSchema(def).map((d) => d.key);
      for (const k of ['bass', 'mids', 'treble', 'kickImpact', 'noiseGate', 'primary', 'background', 'brightness']) expect(keys).toContain(k);
    }
  });

  it('sanitises values: clamps numbers, rounds stepped values, validates colours and options', () => {
    expect(sanitizeParam(STANDARD_PARAMS.scale, 99)).toBe(STANDARD_PARAMS.scale.max);
    expect(sanitizeParam(STANDARD_PARAMS.scale, -5)).toBe(STANDARD_PARAMS.scale.min);
    expect(sanitizeParam(STANDARD_PARAMS.scale, 'big')).toBe(STANDARD_PARAMS.scale.default);
    expect(sanitizeParam(STANDARD_PARAMS.scale, Number.NaN)).toBe(STANDARD_PARAMS.scale.default);
    expect(sanitizeParam(STANDARD_PARAMS.symmetry, 5.6)).toBe(6);
    expect(sanitizeParam(STANDARD_PARAMS.primary, '#ABCDEF')).toMatch(/^#abcdef$/i);
    expect(sanitizeParam(STANDARD_PARAMS.primary, 'javascript:alert(1)')).toBe(STANDARD_PARAMS.primary.default);
    expect(sanitizeParam(STANDARD_PARAMS.gradient, 'rainbow')).toBe(STANDARD_PARAMS.gradient.default);
    const schema = getSceneSchema(getScene('cosmic-rings'));
    const clean = sanitizeParams(schema, { rings: 1e6, unknownKey: 3, __proto__: { evil: 1 } });
    expect(clean.rings).toBe(schema.find((d) => d.key === 'rings')!.max);
    expect('unknownKey' in clean).toBe(false);
    expect(Object.keys(clean).sort()).toEqual(Object.keys(defaultParams(schema)).sort());
  });
});

describe('built-in presets', () => {
  it('cover every scene and only reference valid parameters', () => {
    for (const def of sceneRegistry.list()) expect(BUILTIN_PRESETS.some((p) => p.sceneId === def.id)).toBe(true);
    for (const p of BUILTIN_PRESETS) {
      const keys = new Set(getSceneSchema(getScene(p.sceneId)).map((d) => d.key));
      for (const k of Object.keys({ ...p.params, ...p.colors, ...p.camera })) expect(keys.has(k)).toBe(true);
      for (const m of p.modulations) expect(m.target.startsWith('fx:') || keys.has(m.target)).toBe(true);
    }
  });
});

describe('performance presets', () => {
  it('scale monotonically from eco to ultra and default to balanced', () => {
    const profiles = PERFORMANCE_PRESETS.map((p) => qualityProfile(p.id));
    expect(profiles.map((p) => p.id)).toEqual(['eco', 'balanced', 'quality', 'ultra']);
    for (let i = 1; i < profiles.length; i++) {
      expect(profiles[i].particles).toBeGreaterThanOrEqual(profiles[i - 1].particles);
      expect(profiles[i].maxDpr).toBeGreaterThanOrEqual(profiles[i - 1].maxDpr);
      expect(profiles[i].maxEffects).toBeGreaterThanOrEqual(profiles[i - 1].maxEffects);
    }
    expect(qualityProfile('eco').maxDpr).toBe(1);
    expect(presetFromLegacyQuality('auto')).toBe('balanced');
    expect(presetFromLegacyQuality('low')).toBe('eco');
    expect(presetFromLegacyQuality('high')).toBe('quality');
  });
});

describe('camera framing', () => {
  it('pulls the camera back for portrait so the subject still fits (re-composition, not a crop)', () => {
    const landscape = fitDistance(2, 35, 16 / 9);
    const portrait = fitDistance(2, 35, 9 / 16);
    const square = fitDistance(2, 35, 1);
    expect(portrait).toBeGreaterThan(square);
    expect(square).toBeGreaterThanOrEqual(landscape);
    // in portrait the horizontal half-angle is the limiting one
    const hfov = 2 * Math.atan(Math.tan((35 * Math.PI) / 360) * (9 / 16));
    expect(2 / portrait).toBeLessThanOrEqual(Math.sin(hfov / 2) + 1e-9);
  });

  it('flattens perspective without going below a telephoto minimum', () => {
    expect(effectiveFov(60, 1)).toBe(60);
    expect(effectiveFov(60, 0)).toBe(8);
  });
});

describe('audio feature shaping', () => {
  it('crossfades bands smoothly and sums to one', () => {
    for (const hz of [25, 60, 120, 250, 900, 3000, 8000, 15000]) {
      const w = bandWeights(hz);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    }
    expect(bandWeights(30)[0]).toBeGreaterThan(0.5);
    expect(bandWeights(10000)[3]).toBeGreaterThan(0.5);
  });

  it('noise gate threshold rises with the control', () => {
    expect(gateThresholdDb(0)).toBeLessThan(gateThresholdDb(0.5));
    expect(gateThresholdDb(1)).toBeLessThanOrEqual(-30);
  });

  it('transient sensitivity changes the knee but never explodes', () => {
    expect(shapeTransient(0, 1)).toBe(0);
    expect(shapeTransient(1, 2)).toBeLessThanOrEqual(1.5);
    expect(shapeTransient(0.2, 0.2)).toBeLessThan(shapeTransient(0.2, 1.5));
  });
});

describe('post-processing stack', () => {
  it('creates every effect with defaults inside its ranges', () => {
    for (const def of EFFECTS) {
      const fx = createEffect(def.type, `fx-${def.type}`);
      expect(fx.enabled).toBe(true);
      for (const p of def.params) {
        const v = fx.params[p.key];
        if (p.type === 'number') {
          expect(v as number).toBeGreaterThanOrEqual(p.min!);
          expect(v as number).toBeLessThanOrEqual(p.max!);
        }
      }
    }
  });

  it('reorders, sanitises and caps the stack', () => {
    const stack = [createEffect('bloom', 'a'), createEffect('grain', 'b'), createEffect('vignette', 'c')];
    expect(moveEffect(stack, 'c', -1).map((e) => e.id)).toEqual(['a', 'c', 'b']);
    expect(moveEffect(stack, 'a', -1).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    const junk = [...Array.from({ length: 40 }, (_, i) => createEffect('grain', `g${i}`)), { type: 'laser', id: 'x' }, null];
    const clean = sanitizeStack(junk);
    expect(clean.length).toBe(MAX_STACK);
    expect(clean.every((e) => e.type === 'grain')).toBe(true);
  });

  it('respects the quality budget by keeping only the first enabled effects', () => {
    const stack = [createEffect('bloom', 'a'), { ...createEffect('grain', 'b'), enabled: false }, createEffect('vignette', 'c'), createEffect('glitch', 'd')];
    expect(budgetedEffects(stack, 2).map((e) => e.id)).toEqual(['a', 'c']);
  });
});

describe('per-effect post state', () => {
  it('two kaleidoscopes keep independent spin angles', async () => {
    const { EffectStates } = await import('../src/engine/post/effectState');
    const spins = new EffectStates(() => ({ angle: 0 }));
    const stack = [
      { id: 'a', spin: 10 },
      { id: 'b', spin: -10 },
    ];
    const seen: number[] = [];
    for (let frame = 0; frame < 2; frame++) {
      for (const e of stack) {
        const s = spins.get(e.id);
        s.angle += e.spin; // one second per frame
        seen.push(s.angle);
      }
    }
    expect(seen).toEqual([10, -10, 20, -20]);
  });

  it('releases the state of effects that were removed or stopped rendering, keeps it across reordering', async () => {
    const { EffectStates } = await import('../src/engine/post/effectState');
    const released: string[] = [];
    const store = new EffectStates((id) => ({ id }), (s) => released.push(s.id));
    store.get('t1');
    store.get('t2');
    const first = store.get('t1');
    store.retain(new Set(['t2', 't1'])); // reordered: nothing released
    expect(store.get('t1')).toBe(first);
    store.retain(new Set(['t2'])); // t1 removed / disabled
    expect(released).toEqual(['t1']);
    expect(store.has('t1')).toBe(false);
    store.clear();
    expect(released).toEqual(['t1', 't2']);
    expect(store.size).toBe(0);
  });

  it('renders at most MAX_TRAILS motion trails and reports the rest as bypassed', async () => {
    const { MAX_TRAILS, effectStatus } = await import('../src/engine/post/effects');
    const stack = [createEffect('trails', 't1'), createEffect('bloom', 'b'), createEffect('trails', 't2'), createEffect('trails', 't3'), { ...createEffect('trails', 't4'), enabled: false }];
    const status = effectStatus(stack, 8);
    expect(MAX_TRAILS).toBe(2);
    expect([...status.entries()]).toEqual([
      ['t1', 'active'],
      ['b', 'active'],
      ['t2', 'active'],
      ['t3', 'trails-limit'],
      ['t4', 'off'],
    ]);
    expect(budgetedEffects(stack, 8).map((e) => e.id)).toEqual(['t1', 'b', 't2']);
    // a stored / imported stack with many trails stays intact — only rendering is limited
    expect(sanitizeStack(stack).map((e) => e.id)).toEqual(['t1', 'b', 't2', 't3', 't4']);
  });

  it('the quality budget and the trails limit combine top to bottom', async () => {
    const { effectStatus } = await import('../src/engine/post/effects');
    const stack = [createEffect('grain', 'g'), createEffect('trails', 't1'), createEffect('vignette', 'v'), createEffect('trails', 't2')];
    expect([...effectStatus(stack, 3).values()]).toEqual(['active', 'active', 'active', 'budget']);
  });
});
