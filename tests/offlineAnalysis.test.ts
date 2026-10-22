import { describe, expect, it } from 'vitest';
import { analyzeOffline, downmix } from '../src/audio/dsp/offlineAnalysis';
import { synthesizeTestPattern } from '../src/audio/dsp/testPattern';
import { EventType } from '../src/audio/dsp/events';
import { HAT, KICK, SNARE, eventTimes, matchTimes } from './helpers';

const SR = 22050;
const pattern = synthesizeTestPattern(SR, 120);
const result = analyzeOffline(pattern.samples, SR);

describe('offline analysis on the synthetic test pattern', () => {
  it('finds the kicks at their known positions', () => {
    const m = matchTimes(pattern.kicks, eventTimes(result.events, KICK), 0.03);
    expect(m.recall).toBeGreaterThanOrEqual(0.95);
    expect(m.precision).toBeGreaterThanOrEqual(0.9);
    expect(Math.abs(m.meanError)).toBeLessThan(0.02);
  });

  it('finds the snares and does not mistake them for kicks', () => {
    const m = matchTimes(pattern.snares, eventTimes(result.events, SNARE), 0.03);
    expect(m.recall).toBeGreaterThanOrEqual(0.9);
    expect(m.precision).toBeGreaterThanOrEqual(0.85);
    // snares that do not coincide with a real kick must not produce kick events
    const lonelySnares = pattern.snares.filter((s) => !pattern.kicks.some((k) => Math.abs(k - s) < 0.01));
    expect(lonelySnares.length).toBeGreaterThan(0);
    const kicksOnSnares = matchTimes(lonelySnares, eventTimes(result.events, KICK), 0.03);
    expect(kicksOnSnares.hits).toBe(0);
  });

  it('finds most hi-hats', () => {
    const m = matchTimes(pattern.hats, eventTimes(result.events, HAT), 0.03);
    expect(m.recall).toBeGreaterThanOrEqual(0.85);
    expect(m.precision).toBeGreaterThanOrEqual(0.85);
  });

  it('produces no events in digital silence', () => {
    const [s, e] = pattern.silence;
    const inside = Array.from(result.events.times).filter((t) => t > s + 0.05 && t < e - 0.05);
    expect(inside).toHaveLength(0);
  });

  it('does not turn a held bass note into repeated kicks', () => {
    const [s, e] = pattern.heldBass;
    const kicks = eventTimes(result.events, KICK).filter((t) => t > s + 0.05 && t < e);
    expect(kicks).toHaveLength(0);
  });

  it('keeps the event map sorted and strengths in range', () => {
    const { times, strengths } = result.events;
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    for (const s of strengths) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('estimates the tempo', () => {
    expect(result.bpm).not.toBeNull();
    expect(Math.abs((result.bpm ?? 0) - 120)).toBeLessThanOrEqual(2);
  });

  it('builds a bounded waveform and band map', () => {
    expect(result.buckets).toBeGreaterThanOrEqual(512);
    expect(result.buckets).toBeLessThanOrEqual(4096);
    expect(result.waveform.length).toBe(result.buckets * 2);
    expect(result.bandMap.length).toBe(result.buckets * 3);
    for (const v of result.bandMap) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(result.duration).toBeCloseTo(pattern.duration, 2);
  });
});

describe('offline analysis edge cases', () => {
  it('returns no events for pure silence', () => {
    const r = analyzeOffline(new Float32Array(SR * 5), SR);
    expect(r.events.times.length).toBe(0);
    expect(r.bpm).toBeNull();
  });

  it('returns no events for a very quiet noise floor', () => {
    const n = new Float32Array(SR * 5);
    let seed = 1;
    for (let i = 0; i < n.length; i++) {
      seed = (seed * 16807) % 2147483647;
      n[i] = ((seed / 2147483647) * 2 - 1) * 1e-4; // about -80 dBFS
    }
    const r = analyzeOffline(n, SR);
    expect(r.events.times.length).toBe(0);
  });

  it('treats a continuous bass tone as at most one onset', () => {
    const n = new Float32Array(SR * 6);
    for (let i = 0; i < n.length; i++) {
      const t = i / SR;
      const lfo = 0.8 + 0.2 * Math.sin(2 * Math.PI * 0.5 * t); // slow wobble, not a hit
      n[i] = 0.5 * lfo * Math.min(1, t / 0.01) * Math.sin(2 * Math.PI * 55 * t);
    }
    const r = analyzeOffline(n, SR);
    const kicks = eventTimes(r.events, EventType.KICK);
    expect(kicks.length).toBeLessThanOrEqual(1);
    if (kicks.length === 1) expect(kicks[0]).toBeLessThan(0.1);
  });

  it('downmixes channels by averaging', () => {
    const l = new Float32Array([1, 0, -1]);
    const r = new Float32Array([0, 1, -1]);
    expect(Array.from(downmix([l, r]))).toEqual([0.5, 0.5, -1]);
  });

  it('reports progress up to completion', () => {
    const seen: number[] = [];
    analyzeOffline(new Float32Array(SR * 2), SR, { onProgress: (p) => seen.push(p) });
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});
