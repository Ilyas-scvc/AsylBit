import type { EventMap, EventTypeId } from '../dsp/events';

/** Largest forward step (s) treated as normal playback; bigger jumps are seeks. */
const MAX_STEP = 0.35;
/**
 * Backward steps up to this size (s) mean "the audible position has not reached the cursor
 * yet" — e.g. right after a seek, while output latency is being compensated — so we simply
 * wait. Larger backward jumps without an explicit reset are treated as seeks.
 */
const MAX_WAIT_BACK = 0.5;

/**
 * Plays back a pre-computed event map against the real playback position. Only events in
 * (previous time, current time] fire, and any discontinuity (seek, loop restart, a tab that
 * was in the background) just moves the cursor without firing what was skipped.
 */
export class EventScheduler {
  private map: EventMap | null = null;
  private cursor = 0;
  private lastTime = 0;

  get hasMap(): boolean {
    return this.map !== null;
  }

  setMap(map: EventMap | null, time = 0): void {
    this.map = map;
    this.reset(time);
  }

  /** Move the cursor to `time` without firing anything. */
  reset(time: number): void {
    this.lastTime = time;
    this.cursor = this.map ? lowerBoundAfter(this.map.times, time) : 0;
  }

  /**
   * Advance to `time`, calling `fire` for every event crossed. Returns how many fired.
   * `fire` is a stable callback to keep the render loop allocation-free.
   */
  advance(time: number, fire: (type: EventTypeId, strength: number, at: number) => void): number {
    const map = this.map;
    if (!map) return 0;
    const step = time - this.lastTime;
    if (step < -MAX_WAIT_BACK || step > MAX_STEP) {
      this.reset(time);
      return 0;
    }
    if (step <= 0) return 0;
    let fired = 0;
    const { times, types, strengths } = map;
    while (this.cursor < times.length && times[this.cursor] <= time) {
      if (times[this.cursor] > this.lastTime) {
        fire(types[this.cursor] as EventTypeId, strengths[this.cursor], times[this.cursor]);
        fired++;
      }
      this.cursor++;
    }
    this.lastTime = time;
    return fired;
  }
}

/** Index of the first element strictly greater than `t`. */
export function lowerBoundAfter(times: Float32Array, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
