import { describe, expect, it } from 'vitest';
import { RealtimeAnalyzer, type AnalyzerTuning } from '../src/audio/analysis/RealtimeAnalyzer';
import { synthesizeTestPattern } from '../src/audio/dsp/testPattern';
import { FakeAnalyser } from './fakeAnalyser';
import { matchTimes } from './helpers';

const SR = 48000;
const FPS = 60;
const pattern = synthesizeTestPattern(SR, 120);
const tuning: AnalyzerTuning = { bassSensitivity: 1, midSensitivity: 1, highSensitivity: 1, smoothing: 0.45 };

interface Run {
  kicks: number[];
  snares: number[];
  hats: number[];
  levels: { t: number; bass: number; mid: number; high: number; rmsDb: number }[];
}

function run(signal: Float32Array, opts: { tuning?: AnalyzerTuning; fftSize?: number; from?: number; to?: number } = {}): Run {
  const fake = new FakeAnalyser(signal, SR, opts.fftSize ?? 2048);
  const a = new RealtimeAnalyzer();
  a.configure(fake.fftSize, SR);
  const out: Run = { kicks: [], snares: [], hats: [], levels: [] };
  const from = opts.from ?? 0;
  const to = opts.to ?? signal.length / SR;
  for (let t = from; t <= to; t += 1 / FPS) {
    fake.seek(t);
    a.process(fake, t, 1 / FPS, opts.tuning ?? tuning, true);
    if (a.onsets.kick > 0) out.kicks.push(t);
    if (a.onsets.snare > 0) out.snares.push(t);
    if (a.onsets.hat > 0) out.hats.push(t);
    out.levels.push({ t, bass: a.bass, mid: a.mid, high: a.high, rmsDb: a.rmsDb });
  }
  return out;
}

const full = run(pattern.samples);
// a causal detector sees a hit once it is inside the analysis window: allow one window of delay
const TOL = 0.045;
const shifted = (times: number[]) => times.map((t) => t - 0.012);

describe('real-time analyzer on the test pattern (60 fps, FFT 2048 @ 48 kHz)', () => {
  it('detects kicks causally with good precision and recall', () => {
    const m = matchTimes(pattern.kicks, shifted(full.kicks), TOL);
    expect(m.recall).toBeGreaterThanOrEqual(0.85);
    expect(m.precision).toBeGreaterThanOrEqual(0.85);
  });

  it('detects snares', () => {
    const m = matchTimes(pattern.snares, shifted(full.snares), TOL);
    expect(m.recall).toBeGreaterThanOrEqual(0.75);
    expect(m.precision).toBeGreaterThanOrEqual(0.8);
  });

  it('detects most hats without flooding', () => {
    const m = matchTimes(pattern.hats, shifted(full.hats), TOL);
    expect(m.recall).toBeGreaterThanOrEqual(0.6);
    expect(m.precision).toBeGreaterThanOrEqual(0.8);
  });

  it('fires nothing in digital silence and returns to baseline', () => {
    const [s, e] = pattern.silence;
    const inside = [...full.kicks, ...full.snares, ...full.hats].filter((t) => t > s + 0.05 && t < e);
    expect(inside).toHaveLength(0);
    // the release (smoothing 0.45) brings every level back to rest within ~1.5 s
    const late = full.levels.filter((l) => l.t > s + 1.5 && l.t < e);
    expect(late.length).toBeGreaterThan(10);
    for (const l of late) {
      expect(l.bass).toBeLessThan(0.02);
      expect(l.mid).toBeLessThan(0.02);
      expect(l.high).toBeLessThan(0.02);
    }
  });

  it('does not read the held bass bar as repeated kicks', () => {
    const [s, e] = pattern.heldBass;
    expect(full.kicks.filter((t) => t > s + 0.1 && t < e)).toHaveLength(0);
    // …while the bass level itself is clearly present
    const bassDuring = full.levels.filter((l) => l.t > s + 0.2 && l.t < e - 0.3).map((l) => l.bass);
    expect(Math.min(...bassDuring)).toBeGreaterThan(0.3);
  });

  it('works with FFT 4096 as well', () => {
    const r = run(pattern.samples, { fftSize: 4096, from: 4, to: 12 });
    const expected = pattern.kicks.filter((t) => t >= 4.1 && t <= 11.9);
    const m = matchTimes(expected, r.kicks.map((t) => t - 0.03), 0.06);
    expect(m.recall).toBeGreaterThanOrEqual(0.8);
  });
});

describe('real-time analyzer behaviour', () => {
  it('produces no events and zero levels for pure silence', () => {
    const r = run(new Float32Array(SR * 3));
    expect(r.kicks.length + r.snares.length + r.hats.length).toBe(0);
    expect(Math.max(...r.levels.map((l) => l.bass + l.mid + l.high))).toBe(0);
  });

  it('scales band levels with sensitivity', () => {
    const from = 4;
    const to = 6;
    const base = run(pattern.samples, { from, to });
    const zero = run(pattern.samples, { from, to, tuning: { ...tuning, bassSensitivity: 0, highSensitivity: 2 } });
    const mean = (r: Run, k: 'bass' | 'high') => r.levels.reduce((s, l) => s + l[k], 0) / r.levels.length;
    expect(mean(base, 'bass')).toBeGreaterThan(0.3);
    expect(mean(zero, 'bass')).toBe(0);
    expect(mean(zero, 'high')).toBeGreaterThan(mean(base, 'high') * 1.5);
  });

  it('suppresses detection right after a reset (seek)', () => {
    const fake = new FakeAnalyser(pattern.samples, SR);
    const a = new RealtimeAnalyzer();
    a.configure(2048, SR);
    // play 4.0–4.6, then "seek" into the middle of a hit and check the first frames are quiet
    for (let t = 4; t < 4.6; t += 1 / FPS) {
      fake.seek(t);
      a.process(fake, t, 1 / FPS, tuning, true);
    }
    a.resetDetection();
    let fired = 0;
    for (let i = 0; i < 4; i++) {
      const t = 8.51 + i / FPS;
      fake.seek(t);
      a.process(fake, t, 1 / FPS, tuning, true);
      fired += a.onsets.kick > 0 ? 1 : 0;
    }
    expect(fired).toBe(0);
  });

  it('keeps the display spectrum in range', () => {
    const fake = new FakeAnalyser(pattern.samples, SR);
    const a = new RealtimeAnalyzer();
    a.configure(2048, SR);
    for (let t = 16; t < 18; t += 1 / FPS) {
      fake.seek(t);
      a.process(fake, t, 1 / FPS, tuning, false);
      for (const v of a.spectrum) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1.25);
      }
    }
    expect(Math.max(...a.spectrum)).toBeGreaterThan(0.1);
  });
});
