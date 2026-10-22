import { EventType, type EventMap, type EventTypeId } from '../src/audio/dsp/events';

export function eventTimes(map: EventMap, type: EventTypeId): number[] {
  const out: number[] = [];
  for (let i = 0; i < map.times.length; i++) if (map.types[i] === type) out.push(map.times[i]);
  return out;
}

/** Greedy one-to-one matching of detected vs expected times within a tolerance. */
export function matchTimes(expected: number[], detected: number[], tolerance: number) {
  const used = new Set<number>();
  let hits = 0;
  const errors: number[] = [];
  for (const e of expected) {
    let best = -1;
    let bestErr = Infinity;
    detected.forEach((d, i) => {
      if (used.has(i)) return;
      const err = Math.abs(d - e);
      if (err <= tolerance && err < bestErr) {
        best = i;
        bestErr = err;
      }
    });
    if (best >= 0) {
      used.add(best);
      hits++;
      errors.push(detected[best] - e);
    }
  }
  return {
    hits,
    recall: expected.length ? hits / expected.length : 1,
    precision: detected.length ? hits / detected.length : 1,
    falsePositives: detected.length - hits,
    meanError: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0,
  };
}

export const KICK = EventType.KICK;
export const SNARE = EventType.SNARE;
export const HAT = EventType.HAT;
