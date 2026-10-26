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

/** One call made on a recording 2D context, with the fill colour in effect. */
export interface DrawCall {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  /** shadow in effect (blur, x offset), when one is set */
  shadow?: [number, number];
}

/**
 * A 2D context that records every method call. measureText is monospace-like: 0.6 em per
 * glyph of the current font size.
 */
export function recordingContext(calls: DrawCall[]): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { font: '400 10px mono', fillStyle: '#000' };
  return new Proxy(state, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'measureText') return (s: string) => ({ width: [...s].length * Number.parseFloat(String(t.font).split(' ')[1]) * 0.6 });
      const shadow: [number, number] | undefined = t.shadowBlur ? [Number(t.shadowBlur), Number(t.shadowOffsetX ?? 0)] : undefined;
      return (...args: unknown[]) => void calls.push({ op: String(p), args, fillStyle: t.fillStyle, ...(shadow && { shadow }) });
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}
