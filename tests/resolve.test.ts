import { describe, expect, it } from 'vitest';
import { createAudioFrame } from '../src/audio/analysis/frame';
import { attackRelease } from '../src/audio/dsp/envelope';
import { createBinding, type ModulationBinding } from '../src/engine/modulation';
import { defaultParams, getSceneSchema, schemaMap } from '../src/engine/params';
import { createEffect } from '../src/engine/post/effects';
import { FrameResolver } from '../src/engine/resolve';
import { getScene } from '../src/engine/scenes/registry';

const schema = getSceneSchema(getScene('pulse-object'));
const defs = schemaMap(schema);
const base = defaultParams(schema);

function frame() {
  const f = createAudioFrame();
  f.hasTrack = f.playing = true;
  f.bass = 0.4;
  f.sub = 0.3;
  f.mid = 0.3;
  f.high = 0.2;
  f.rms = 0.5;
  f.rmsDb = -12;
  f.kick = 0.6;
  f.snare = 0.5;
  f.spectrum.fill(0.4);
  return f;
}

/** A binding that is fully "on" from the first frame: LFO at its peak, instant envelope. */
const full = (target: string, amount: number): ModulationBinding => ({ ...createBinding(target, 'lfo', `m-${target}`), amount, attack: 0, release: 0, lfoRate: 1 });

function resolveAt(modulations: ModulationBinding[], params = base, frames = 10) {
  const r = new FrameResolver();
  let audio = r.resolve(defs, { frame: frame(), time: 0.25, dt: 1 / 60, params, modulations, post: [], maxEffects: 8 });
  for (let i = 1; i < frames; i++) audio = r.resolve(defs, { frame: frame(), time: 0.25, dt: 1 / 60, params, modulations, post: [], maxEffects: 8 });
  return { r, audio };
}

describe('AUDIO REACTION parameters under modulation', () => {
  it('a modulated BASS changes what the scene receives (the reported case: 1 → 2.25)', () => {
    const { r, audio } = resolveAt([full('bass', 0.5)]);
    expect(r.values.bass).toBeCloseTo(2.25, 5);
    expect(audio.bass).toBeCloseTo(0.4 * 2.25, 5);
  });

  it('every AUDIO REACTION control reaches the scene features', () => {
    const plain = resolveAt([]).audio;
    const cases: [string, (a: typeof plain) => number][] = [
      ['subBass', (a) => a.sub],
      ['mids', (a) => a.mids],
      ['treble', (a) => a.treble],
      ['kickImpact', (a) => a.kick],
      ['snareImpact', (a) => a.snare],
      ['transientSensitivity', (a) => a.kick],
    ];
    for (const [key, read] of cases) {
      const before = read(plain);
      const after = read(resolveAt([full(key, 0.5)]).audio);
      expect(after, key).toBeGreaterThan(before);
    }
    // NOISE GATE raised to its maximum (−30 dB) closes the gate on a quiet (−40 dB) signal
    const quiet = () => Object.assign(frame(), { rmsDb: -40 });
    const run = (mods: ModulationBinding[]) => {
      const r = new FrameResolver();
      let a = r.resolve(defs, { frame: quiet(), time: 0.25, dt: 1 / 60, params: base, modulations: mods, post: [], maxEffects: 8 });
      for (let i = 0; i < 10; i++) a = r.resolve(defs, { frame: quiet(), time: 0.25, dt: 1 / 60, params: base, modulations: mods, post: [], maxEffects: 8 });
      return { r, a };
    };
    const open = run([]).a.bass;
    const gated = run([full('noiseGate', 1)]);
    expect(gated.r.values.noiseGate).toBe(1);
    expect(open).toBeGreaterThan(0.3);
    expect(gated.a.bass).toBeLessThan(open * 0.1);
  });

  it('modulation sources read the base settings: no feedback loop', () => {
    // BASS driven by the bass signal itself: its source must not grow with its own output
    const bind: ModulationBinding = { ...createBinding('bass', 'bass', 'm-self'), amount: 1, attack: 0, release: 0 };
    const r = new FrameResolver();
    const seen: number[] = [];
    for (let i = 0; i < 30; i++) {
      r.resolve(defs, { frame: frame(), time: i / 60, dt: 1 / 60, params: base, modulations: [bind], post: [], maxEffects: 8 });
      seen.push(r.values.bass as number);
    }
    expect(r.sourceFeatures.out.bass).toBeCloseTo(0.4, 6); // base sensitivity 1
    // once the (5 ms minimum) envelope has settled the value is steady — no runaway
    expect(new Set(seen.slice(10).map((v) => v.toFixed(6))).size).toBe(1);
    expect(seen.at(-1)).toBeCloseTo(1 + 0.4 * 2.5, 4);
  });

  it('each envelope advances exactly once per frame', () => {
    const attack = 0.2;
    const bind: ModulationBinding = { ...createBinding('zoom', 'lfo', 'm-zoom'), amount: 1, attack, release: attack, lfoRate: 1 };
    const fx = createEffect('bloom', 'fx-b');
    const fxBind: ModulationBinding = { ...createBinding('fx:fx-b:intensity', 'lfo', 'm-fx'), amount: 1, attack, release: attack, lfoRate: 1 };
    const r = new FrameResolver();
    r.resolve(defs, { frame: frame(), time: 0.25, dt: 1 / 60, params: base, modulations: [bind, fxBind], post: [fx], maxEffects: 8 });
    const oneStep = attackRelease(0, 1, 1 / 60, attack, attack);
    expect(r.modulation.level('m-zoom')).toBeCloseTo(oneStep, 9);
    expect(r.modulation.level('m-fx')).toBeCloseTo(oneStep, 9);
  });

  it('a snapshot without some parameters still modulates them from their defaults', () => {
    const { r } = resolveAt([full('zoom', 0.25)], {});
    const zoom = defs.get('zoom')!;
    expect(r.values.zoom).toBeCloseTo((zoom.default as number) + 0.25 * (zoom.max! - zoom.min!), 5);
  });

  it('is deterministic: the same inputs give the same frames (live and export share this code)', () => {
    const a = resolveAt([full('bass', 0.5), full('kickImpact', 0.3)], base, 20);
    const b = resolveAt([full('bass', 0.5), full('kickImpact', 0.3)], base, 20);
    expect(a.audio.bass).toBe(b.audio.bass);
    expect(a.audio.kick).toBe(b.audio.kick);
    expect(a.r.values).toEqual(b.r.values);
  });
});
