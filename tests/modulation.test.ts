import { describe, expect, it } from 'vitest';
import { createSceneAudio } from '../src/engine/features';
import { createBinding, ModulationEngine, sanitizeBinding, shapeValue, sourceValue, type ModulationBinding } from '../src/engine/modulation';
import { defaultParams, getSceneSchema, schemaMap } from '../src/engine/params';
import { getScene } from '../src/engine/scenes/registry';

const schema = getSceneSchema(getScene('pulse-object'));
const defs = schemaMap(schema);
const base = defaultParams(schema);
const zoom = defs.get('zoom')!;

function run(binding: ModulationBinding, source: (t: number) => number, seconds: number, fps = 60) {
  const eng = new ModulationEngine();
  const audio = createSceneAudio();
  const values: number[] = [];
  for (let n = 0; n < seconds * fps; n++) {
    const t = n / fps;
    audio.bass = audio.kick = audio.mids = audio.treble = audio.rms = audio.snare = source(t);
    const out = { ...base };
    eng.apply([binding], defs, base, audio, t, 1 / fps, out);
    values.push(out[binding.target] as number);
  }
  return values;
}

describe('modulation shaping', () => {
  const b = { threshold: 0, min: 0, max: 1, curve: 'linear' as const, invert: false };

  it('is the identity for a default binding and clamps input', () => {
    expect(shapeValue(0.3, b)).toBeCloseTo(0.3);
    expect(shapeValue(2, b)).toBe(1);
    expect(shapeValue(-1, b)).toBe(0);
  });

  it('applies threshold, window, curve and invert in order', () => {
    expect(shapeValue(0.2, { ...b, threshold: 0.25 })).toBe(0);
    expect(shapeValue(1, { ...b, threshold: 0.25 })).toBe(1);
    expect(shapeValue(0.5, { ...b, min: 0.5, max: 1 })).toBe(0);
    expect(shapeValue(0.75, { ...b, min: 0.5, max: 1 })).toBeCloseTo(0.5);
    expect(shapeValue(0.5, { ...b, curve: 'exp' })).toBeCloseTo(0.25);
    expect(shapeValue(0.25, { ...b, curve: 'log' })).toBeCloseTo(0.5);
    expect(shapeValue(0.5, { ...b, curve: 'smooth' })).toBeCloseTo(0.5);
    expect(shapeValue(0.2, { ...b, invert: true })).toBeCloseTo(0.8);
  });

  it('every curve is monotonic', () => {
    for (const curve of ['linear', 'exp', 'log', 'smooth'] as const) {
      let prev = -1;
      for (let i = 0; i <= 100; i++) {
        const v = shapeValue(i / 100, { ...b, curve });
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it('the LFO is a deterministic function of time', () => {
    const a = createSceneAudio();
    expect(sourceValue('lfo', a, 0, 1)).toBeCloseTo(0.5);
    expect(sourceValue('lfo', a, 0.25, 1)).toBeCloseTo(1);
    expect(sourceValue('lfo', a, 1.25, 1)).toBeCloseTo(sourceValue('lfo', a, 0.25, 1));
    expect(sourceValue('off', a, 3, 1)).toBe(0);
  });
});

describe('modulation engine', () => {
  it('Off leaves the parameter at its base value', () => {
    const values = run({ ...createBinding('zoom', 'off'), amount: 1 }, () => 1, 1);
    expect(values.every((v) => v === base.zoom)).toBe(true);
  });

  it('modulates around the base value by amount × range and stays in range', () => {
    const amount = 0.25;
    const values = run({ ...createBinding('zoom', 'bass'), amount, attack: 0.005 }, () => 1, 1);
    const expected = Math.min(zoom.max!, (base.zoom as number) + amount * (zoom.max! - zoom.min!));
    expect(values.at(-1)).toBeCloseTo(expected, 3);
    const neg = run({ ...createBinding('zoom', 'bass'), amount: -1, attack: 0.005 }, () => 1, 1);
    expect(neg.at(-1)).toBe(zoom.min);
  });

  it('attack and release smooth a hard step: no jumps', () => {
    const binding = { ...createBinding('zoom', 'kick'), amount: 1, attack: 0.1, release: 0.4 };
    const step = (t: number) => (t >= 0.5 && t < 1.5 ? 1 : 0);
    const values = run(binding, step, 3);
    const range = zoom.max! - zoom.min!;
    let maxDelta = 0;
    for (let i = 1; i < values.length; i++) maxDelta = Math.max(maxDelta, Math.abs(values[i] - values[i - 1]));
    // a 0.1 s attack at 60 fps can move at most ~1/6 of the range per frame
    expect(maxDelta / range).toBeLessThan(0.2);
    // release is slower than attack
    const up = values.findIndex((v) => v - (base.zoom as number) > 0.5 * (values[89] - (base.zoom as number)));
    const downStart = 90;
    const down = values.slice(downStart).findIndex((v) => v - (base.zoom as number) < 0.5 * (values[89] - (base.zoom as number)));
    expect(up - 30).toBeLessThan(down);
  });

  it('is frame-rate independent', () => {
    const binding = { ...createBinding('zoom', 'bass'), amount: 0.5, attack: 0.2, release: 0.2 };
    const at30 = run(binding, (t) => (t > 0.2 ? 1 : 0), 1, 30);
    const at60 = run(binding, (t) => (t > 0.2 ? 1 : 0), 1, 60);
    expect(at30[15]).toBeCloseTo(at60[30], 1);
  });

  it('ignores bindings to unknown or non-modulatable targets', () => {
    const eng = new ModulationEngine();
    const out = { ...base };
    eng.apply([{ ...createBinding('symmetry', 'bass'), amount: 1 }, { ...createBinding('nope', 'bass'), amount: 1 }], defs, base, { ...createSceneAudio(), bass: 1 }, 0, 1, out);
    expect(out).toEqual(base);
  });

  it('sanitises imported bindings', () => {
    expect(sanitizeBinding(null)).toBeNull();
    expect(sanitizeBinding({ target: 'zoom', source: 'laser' })?.source ?? 'off').not.toBe('laser');
    const b = sanitizeBinding({ id: 'x', target: 'zoom', source: 'bass', amount: 50, attack: -1, curve: 'zigzag', threshold: 5 })!;
    expect(b.amount).toBeLessThanOrEqual(1);
    expect(b.attack).toBeGreaterThanOrEqual(0);
    expect(b.curve).toBe('linear');
    expect(b.threshold).toBeLessThan(1);
  });
});
