import { describe, expect, it } from 'vitest';
import { EventScheduler, lowerBoundAfter } from '../src/audio/analysis/EventScheduler';
import type { EventMap } from '../src/audio/dsp/events';

const map: EventMap = {
  times: new Float32Array([0.5, 1.0, 1.5, 2.0, 2.5, 3.0]),
  strengths: new Float32Array([1, 0.9, 0.8, 0.7, 0.6, 0.5]),
  types: new Uint8Array([0, 1, 0, 2, 0, 1]),
};

function collect(s: EventScheduler, steps: number[]): number[] {
  const fired: number[] = [];
  for (const t of steps) s.advance(t, (_type, _strength, at) => fired.push(at));
  return fired;
}

describe('EventScheduler', () => {
  it('fires each event exactly once as playback passes it', () => {
    const s = new EventScheduler();
    s.setMap(map, 0);
    const steps: number[] = [];
    for (let t = 0; t <= 3.2; t += 1 / 60) steps.push(t);
    expect(collect(s, steps)).toEqual([0.5, 1, 1.5, 2, 2.5, 3]);
  });

  it('does not fire events skipped by a forward seek', () => {
    const s = new EventScheduler();
    s.setMap(map, 0);
    expect(collect(s, [0.1, 0.3, 0.45, 0.55])).toEqual([0.5]);
    s.reset(2.2); // explicit seek
    expect(collect(s, [2.25, 2.3, 2.45, 2.6])).toEqual([2.5]);
  });

  it('treats a large jump without reset as a seek (no burst of events)', () => {
    const s = new EventScheduler();
    s.setMap(map, 0);
    expect(collect(s, [0.1, 2.7, 2.75, 2.9, 3.05])).toEqual([3]);
  });

  it('does not replay events after a backward seek / loop restart', () => {
    const s = new EventScheduler();
    s.setMap(map, 0);
    collect(s, [0.4, 0.6, 1.1]);
    s.reset(0.0); // loop back to start
    expect(collect(s, [0.2, 0.45, 0.52])).toEqual([0.5]);
  });

  it('waits while the audible time trails the cursor (latency compensation)', () => {
    const s = new EventScheduler();
    s.setMap(map, 0);
    s.reset(1.2); // seek to 1.2, the audible clock starts 40 ms behind
    expect(collect(s, [1.16, 1.18, 1.2, 1.21])).toEqual([]);
    expect(collect(s, [1.3, 1.52])).toEqual([1.5]);
  });

  it('does nothing without a map', () => {
    const s = new EventScheduler();
    expect(s.hasMap).toBe(false);
    expect(collect(s, [0, 1, 2])).toEqual([]);
  });

  it('lowerBoundAfter returns the first index strictly after t', () => {
    expect(lowerBoundAfter(map.times, 0)).toBe(0);
    expect(lowerBoundAfter(map.times, 0.5)).toBe(1);
    expect(lowerBoundAfter(map.times, 1.2)).toBe(2);
    expect(lowerBoundAfter(map.times, 10)).toBe(6);
  });
});
