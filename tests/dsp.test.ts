import { describe, expect, it } from 'vitest';
import { FFT, hannWindow, nextPowerOfTwo } from '../src/audio/dsp/fft';
import { BASS, HIGH, LogBandMapper, MID, bandBins, binToHz, hzToBin } from '../src/audio/dsp/bands';
import { Spring, attackRelease, decay, retention } from '../src/audio/dsp/envelope';
import { AdaptiveOnsetTracker, percentile, pickPeaks } from '../src/audio/dsp/onset';
import { encodeWav } from '../src/audio/dsp/wav';
import { PlaybackClock } from '../src/audio/engine/PlaybackClock';

describe('FFT', () => {
  it('puts a sine at the right bin', () => {
    const N = 1024;
    const sr = 22050;
    const bin = 37;
    const freq = (bin * sr) / N;
    const x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / sr);
    const out = new Float32Array(N / 2 + 1);
    new FFT(N).magnitudes(x, 0, hannWindow(N), out);
    let best = 0;
    for (let k = 1; k < out.length; k++) if (out[k] > out[best]) best = k;
    expect(best).toBe(bin);
    expect(out[bin] * (4 / N)).toBeCloseTo(1, 1); // normalisation used by the analysis
  });

  it('rejects non power-of-two sizes', () => {
    expect(() => new FFT(1000)).toThrow();
    expect(nextPowerOfTwo(1000)).toBe(1024);
  });
});

describe('frequency bands', () => {
  it('maps band edges to bins for different rates and FFT sizes', () => {
    for (const [sr, n] of [
      [44100, 2048],
      [48000, 2048],
      [48000, 4096],
      [22050, 1024],
    ]) {
      const bass = bandBins(BASS, sr, n);
      const mid = bandBins(MID, sr, n);
      const high = bandBins(HIGH, sr, n);
      expect(bass.start).toBeGreaterThanOrEqual(1);
      expect(binToHz(bass.end - 1, sr, n)).toBeLessThanOrEqual(BASS.hi + sr / n);
      expect(mid.start).toBeGreaterThanOrEqual(bass.end - 2);
      expect(high.end).toBeLessThanOrEqual(n / 2);
      expect(bass.end).toBeGreaterThan(bass.start);
    }
    expect(hzToBin(1000, 48000, 4096)).toBeCloseTo(85.33, 2);
  });

  it('clamps bands above Nyquist', () => {
    const s = bandBins({ lo: 7000, hi: 14000 }, 22050, 1024);
    expect(s.end).toBeLessThanOrEqual(512);
    expect(s.end).toBeGreaterThan(s.start);
  });

  it('log mapper covers the spectrum smoothly', () => {
    const m = new LogBandMapper(96, 30, 16000, 48000, 2048);
    const power = new Float32Array(1024).fill(1);
    const out = new Float32Array(96);
    m.map(power, out);
    for (const v of out) expect(v).toBeCloseTo(1, 5);
    for (let i = 1; i < 96; i++) expect(m.centers[i]).toBeGreaterThan(m.centers[i - 1]);
  });
});

describe('envelopes', () => {
  it('attack/release are frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = attackRelease(a, 1, 1 / 60, 0.1, 0.5);
    let b = 0;
    for (let i = 0; i < 30; i++) b = attackRelease(b, 1, 1 / 30, 0.1, 0.5);
    expect(a).toBeCloseTo(b, 6);
    expect(retention(0.1, 0.1)).toBeCloseTo(Math.exp(-1), 6);
  });

  it('release is slower than attack', () => {
    const up = attackRelease(0, 1, 0.05, 0.02, 0.5);
    const down = attackRelease(1, 0, 0.05, 0.02, 0.5);
    expect(up).toBeGreaterThan(0.9);
    expect(down).toBeGreaterThan(0.9);
  });

  it('decay snaps to exactly zero', () => {
    let v = 1;
    for (let i = 0; i < 400; i++) v = decay(v, 1 / 60, 0.1);
    expect(v).toBe(0);
  });

  it('spring returns to rest without blowing up on long frames', () => {
    const s = new Spring(1);
    s.step(1.3, 0.05);
    for (let i = 0; i < 200; i++) s.step(1, 0.1);
    expect(s.value).toBeCloseTo(1, 4);
  });
});

describe('onset helpers', () => {
  it('peak picking finds isolated peaks and keeps the stronger of close pairs', () => {
    const odf = new Float32Array(100);
    odf[10] = 1;
    odf[50] = 0.6;
    odf[53] = 0.9;
    const peaks = pickPeaks(odf, { preMax: 2, postMax: 2, preAvg: 5, postAvg: 5, delta: 0.1, minValue: 0.2, wait: 6 });
    expect(peaks).toEqual([10, 53]);
  });

  it('adaptive tracker ignores silence and respects the refractory period', () => {
    const tr = new AdaptiveOnsetTracker({ window: 1, lambda: 2, mu: 0.5, floor: 0.1, refractory: 0.2, riseDb: 3, riseWindow: 0.1, gateDb: -60, rearm: 0.5, warmup: 3 });
    let fired = 0;
    for (let i = 0; i < 120; i++) fired += tr.push(i / 60, 0, -200) > 0 ? 1 : 0;
    expect(fired).toBe(0);
    // two hits 100 ms apart: only the first may fire
    const t0 = 2;
    for (let i = 0; i < 6; i++) tr.push(t0 + i / 60, 0, -40);
    expect(tr.push(t0 + 0.1, 1, -10)).toBeGreaterThan(0);
    tr.push(t0 + 0.12, 0, -30);
    expect(tr.push(t0 + 0.2, 1, -10)).toBe(0);
  });

  it('a vetoed frame does not consume the refractory period', () => {
    const tr = new AdaptiveOnsetTracker({ window: 1, lambda: 2, mu: 0.5, floor: 0.1, refractory: 0.2, riseDb: 3, riseWindow: 0.1, gateDb: -60, rearm: 0.5, warmup: 3 });
    for (let i = 0; i < 10; i++) tr.push(i / 60, 0, -50);
    expect(tr.push(0.2, 1, -10, false)).toBe(0);
    expect(tr.push(0.22, 1, -10, true)).toBeGreaterThan(0);
  });

  it('percentile works on large arrays', () => {
    const a = new Float32Array(100000);
    for (let i = 0; i < a.length; i++) a[i] = i / a.length;
    expect(percentile(a, 0.5)).toBeCloseTo(0.5, 2);
  });
});

describe('PlaybackClock', () => {
  it('does not run ahead before media time actually advances', () => {
    const c = new PlaybackClock();
    c.reset(10, 0);
    // play() was called but the element still reports 10.0 for 40 ms
    expect(c.read(10, 20, true)).toBe(10);
    expect(c.read(10, 40, true)).toBe(10);
    // now it advances: extrapolation may smooth between coarse updates
    expect(c.read(10.05, 90, true)).toBeCloseTo(10.05, 6);
    expect(c.read(10.05, 100, true)).toBeCloseTo(10.06, 6);
  });

  it('follows real jumps backwards (seek / loop)', () => {
    const c = new PlaybackClock();
    c.reset(5, 0);
    c.read(5.1, 100, true);
    expect(c.read(0.02, 120, true)).toBeCloseTo(0.02, 6);
  });
});

describe('WAV encoder', () => {
  it('writes a valid 16-bit PCM header and clamps samples', () => {
    const buf = encodeWav([new Float32Array([0, 1, -1, 2])], 44100);
    const v = new DataView(buf);
    const str = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    expect(str(0)).toBe('RIFF');
    expect(str(8)).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(40, true)).toBe(8);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
    expect(v.getInt16(50, true)).toBe(32767);
  });
});
