import { describe, expect, it } from 'vitest';
import { createAudioFrame } from '../src/audio/analysis/frame';
import { EventType } from '../src/audio/dsp/events';
import { AudioFeatureProvider } from '../src/engine/features';
import { defaultParams, getSceneSchema, ValuesReader } from '../src/engine/params';
import { getScene } from '../src/engine/scenes/registry';
import { KICK_WAVE, KickWaves, softLimit } from '../src/engine/scenes/kickWaves';

/** Run a kick pattern at a frame rate; `probe` sees the pool after every frame. */
function simulate(fps: number, kicks: number[], seconds: number, rate = 1, probe?: (t: number, w: KickWaves) => void, strength = 1) {
  const w = new KickWaves();
  const dt = 1 / fps;
  const pending = [...kicks];
  const frames = Math.round(seconds * fps);
  for (let n = 1; n <= frames; n++) {
    const t = n * dt;
    // the scene's order: running waves advance, then a kick reported on this frame starts one
    w.step(dt, rate);
    while (pending.length && pending[0] <= t + 1e-9) {
      pending.shift();
      w.hit(strength);
    }
    probe?.(t, w);
  }
  return w;
}

describe('kick waves: a new kick adds a wave, it does not restart the surface', () => {
  it('the previous wave survives the next kick and keeps travelling and fading', () => {
    const w = new KickWaves();
    w.hit(1);
    for (let i = 0; i < 24; i++) w.step(1 / 60, 1); // 0.4 s
    const [oldLevel] = w.levels();
    const oldAge = w.ages()[0];
    w.hit(1);
    expect(w.count).toBe(2);
    // the kick itself changes nothing about the running wave
    expect(w.levels()[0]).toBe(oldLevel);
    w.step(1 / 60, 1);
    expect(w.ages()[0]).toBeCloseTo(oldAge + 1 / 60, 9);
    // it continues smoothly (one frame of decay, not a reset)
    expect(w.levels()[0]).toBeGreaterThan(oldLevel * 0.97);
    expect(w.levels()[0]).toBeLessThan(oldLevel);
    // and its ring is further out than the new one
    const radii = new Float32Array(KICK_WAVE.slots * 2);
    w.write(radii);
    expect(radii[0]).toBeGreaterThan(radii[2]);
  });

  it('kicks every 0.5 s (the test pattern) overlap instead of cutting each other off', () => {
    let maxCount = 0;
    simulate(60, [0.5, 1.0, 1.5, 2.0], 2.2, 1, (_, w) => (maxCount = Math.max(maxCount, w.count)));
    expect(maxCount).toBeGreaterThanOrEqual(2);
  });
});

describe('kick waves: attack', () => {
  for (const fps of [30, 60, 144]) {
    it(`never appears at full amplitude (${fps} fps)`, () => {
      const w = new KickWaves();
      w.hit(1);
      expect(w.levels()[0]).toBe(0); // the frame that reports the kick: the wave starts at age 0
      w.step(1 / fps, 1);
      const next = w.levels()[0];
      expect(next).toBeGreaterThan(0); // rising on the very next frame
      expect(next).toBeLessThan(0.7); // even at 30 fps, well short of the peak
    });
  }

  it('rises within 20–60 ms', () => {
    const w = new KickWaves();
    w.hit(1);
    let t = 0;
    let peak = 0;
    let t90 = -1;
    const trace: [number, number][] = [];
    while (t < 0.2) {
      w.step(0.001, 1);
      t += 0.001;
      const l = w.levels()[0];
      trace.push([t, l]);
      peak = Math.max(peak, l);
    }
    for (const [time, l] of trace) {
      if (l >= 0.9 * peak) {
        t90 = time;
        break;
      }
    }
    expect(t90).toBeGreaterThanOrEqual(0.02);
    expect(t90).toBeLessThanOrEqual(0.06);
    expect(peak).toBeGreaterThan(0.9);
  });

  it('the deformation at the centre changes gradually, with no jump on later kicks', () => {
    let prev = 0;
    let worstLaterKick = 0;
    simulate(60, [0.5, 1.0, 1.5, 2.0, 2.5], 3, 1, (t, w) => {
      const v = w.sample(0);
      // after the first kick, a new kick never jumps the surface by more than its own attack step
      if (t > 0.9) worstLaterKick = Math.max(worstLaterKick, Math.abs(v - prev));
      prev = v;
    });
    expect(worstLaterKick).toBeLessThan(0.55);
  });
});

describe('kick waves: KICK IMPACT 0 and the noise gate', () => {
  it('a kick of strength 0 adds nothing', () => {
    const w = new KickWaves();
    w.hit(0);
    w.hit(0.005);
    expect(w.count).toBe(0);
  });

  it('the feature provider reports a 0 peak with KICK IMPACT 0 or a closed gate', () => {
    const reader = new ValuesReader();
    const base = defaultParams(getSceneSchema(getScene('reactive-mesh')));
    const frame = createAudioFrame();
    frame.lastPeak[EventType.KICK] = 1;
    frame.rmsDb = -12;
    const f = new AudioFeatureProvider();
    reader.values = { ...base };
    expect(f.build(frame, reader).kickPeak).toBeGreaterThan(0.5);
    reader.values = { ...base, kickImpact: 0 };
    expect(f.build(frame, reader).kickPeak).toBe(0);
    reader.values = { ...base, noiseGate: 1 };
    frame.rmsDb = -60; // well below the −30 dB gate
    expect(f.build(frame, reader).kickPeak).toBe(0);
  });
});

describe('kick waves: slow SPEED and dense kicks', () => {
  it('stays within the pool and never drops a visible wave abruptly', () => {
    let maxLive = 0;
    let maxSlots = 0;
    let worstDrop = 0;
    let prevTotal = 0;
    const kicks = Array.from({ length: 50 }, (_, i) => 0.1 + i * 0.1); // 10 kicks per second for 5 s
    simulate(
      60,
      kicks,
      8,
      0.2, // minimum SPEED
      (_, w) => {
        maxLive = Math.max(maxLive, w.live);
        maxSlots = Math.max(maxSlots, w.count);
        const total = w.levels().reduce((s, l) => s + l, 0);
        worstDrop = Math.max(worstDrop, prevTotal - total);
        prevTotal = total;
      },
    );
    expect(maxLive).toBeLessThanOrEqual(KICK_WAVE.capacity);
    expect(maxSlots).toBeLessThan(KICK_WAVE.slots); // the forced drop is never needed
    // one retiring wave loses at most ~1/7 of its level per 60 fps frame — never all at once
    expect(worstDrop).toBeLessThan(0.3);
  });

  it('a lone wave at minimum SPEED still fades out completely', () => {
    const w = simulate(60, [0.1], KICK_WAVE.life + 0.5, 0.2);
    expect(w.count).toBe(0);
  });

  it('overlapping waves are soft-limited', () => {
    const w = simulate(60, Array.from({ length: 12 }, (_, i) => i * 0.07), 0.9, 0.2);
    let raw = 0;
    for (const l of w.levels()) raw += l;
    expect(raw).toBeGreaterThan(KICK_WAVE.ceiling); // they really do stack up …
    for (let r = 0; r <= 1; r += 0.05) expect(w.sample(r)).toBeLessThanOrEqual(KICK_WAVE.ceiling); // … but the surface does not
    expect(softLimit(0.5)).toBe(0.5); // a single ordinary wave is untouched
    expect(softLimit(10)).toBeLessThanOrEqual(KICK_WAVE.ceiling);
    for (let x = 0; x < 5; x += 0.1) expect(softLimit(x + 0.1)).toBeGreaterThan(softLimit(x));
  });
});

describe('kick waves: frame rate and export reproducibility', () => {
  const kicks = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
  // times that are frame boundaries at 30, 60 and 144 fps
  const probes = [0.5 + 1 / 6, 1, 1.5 + 2 / 6, 2, 3 + 1 / 6, 3.5];
  const record = (fps: number) => {
    const out: number[] = [];
    simulate(fps, kicks, 3.6, 1, (t, w) => {
      if (probes.some((p) => Math.abs(p - t) < 1e-6)) for (const r of [0, 0.2, 0.45, 0.8]) out.push(w.sample(r));
    });
    return out;
  };

  it('gives the same surface at 30, 60 and 144 fps', () => {
    const a = record(30);
    const b = record(60);
    const c = record(144);
    expect(a).toHaveLength(probes.length * 4);
    a.forEach((v, i) => {
      expect(b[i]).toBeCloseTo(v, 6);
      expect(c[i]).toBeCloseTo(v, 6);
    });
  });

  it('is deterministic run to run (exports reproduce it)', () => {
    expect(record(30)).toEqual(record(30));
  });
});
