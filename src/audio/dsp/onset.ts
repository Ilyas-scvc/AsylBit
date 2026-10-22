/**
 * Onset detection building blocks.
 *
 * Both detectors work on a spectral-flux style onset detection function (ODF) — the
 * summed positive change of the log spectrum — instead of raw loudness, so a held
 * bass note or a sustained pad does not register as a new hit. On top of the flux
 * peak they require a real rise in band energy, a minimum gap between events and an
 * absolute level gate, which keeps silence and noise floors from producing events.
 */

export interface AdaptiveOnsetOptions {
  /** seconds of flux history used for the adaptive threshold */
  window: number;
  /** threshold = floor + lambda * median + mu * mean of recent flux */
  lambda: number;
  mu: number;
  /** absolute minimum threshold, protects against triggering on noise */
  floor: number;
  /** minimum seconds between two onsets of this tracker */
  refractory: number;
  /** band level must rise at least this many dB above its recent minimum */
  riseDb: number;
  /** seconds to look back for that recent minimum */
  riseWindow: number;
  /** band level (dB) must be above this for an onset to count */
  gateDb: number;
  /** flux must fall below threshold * rearm before the tracker can fire again */
  rearm: number;
  /** history entries required after a reset before the tracker may fire */
  warmup: number;
}

const CAPACITY = 512;

/**
 * Causal (real-time) onset tracker with a median-based adaptive threshold and hysteresis.
 * The median is robust to the sparse, spiky shape of an onset function: one loud hit does
 * not raise the bar for the next ones the way a mean + std threshold would.
 */
export class AdaptiveOnsetTracker {
  readonly options: AdaptiveOnsetOptions;
  /** last computed threshold, exposed for diagnostics */
  threshold = 0;
  private readonly times = new Float64Array(CAPACITY);
  private readonly flux = new Float32Array(CAPACITY);
  private readonly levels = new Float32Array(CAPACITY);
  private readonly scratch = new Float32Array(CAPACITY);
  private head = 0;
  private size = 0;
  private lastOnset = -Infinity;
  private armed = true;

  constructor(options: AdaptiveOnsetOptions) {
    this.options = options;
  }

  /**
   * Feed one analysis frame. Returns the onset strength in (0, 1] when this frame is an
   * onset, otherwise 0. `allow = false` vetoes an onset (e.g. it failed a classification
   * check) without consuming the refractory period, so a real hit on the next frame can
   * still fire.
   */
  push(time: number, flux: number, levelDb: number, allow = true): number {
    const o = this.options;
    let sum = 0;
    let n = 0;
    let minLevel = Infinity;
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - 1 - i + CAPACITY) % CAPACITY;
      const age = time - this.times[idx];
      if (age > o.window) break;
      const f = this.flux[idx];
      this.scratch[n] = f;
      sum += f;
      n++;
      if (age <= o.riseWindow && this.levels[idx] < minLevel) minLevel = this.levels[idx];
    }
    const mean = n > 0 ? sum / n : 0;
    let median = 0;
    if (n > 0) {
      const view = this.scratch.subarray(0, n);
      view.sort();
      median = n & 1 ? view[n >> 1] : 0.5 * (view[(n >> 1) - 1] + view[n >> 1]);
    }
    const thr = o.floor + o.lambda * median + o.mu * mean;
    this.threshold = thr;

    if (!this.armed && flux < thr * o.rearm) this.armed = true;

    let strength = 0;
    if (
      allow &&
      n >= o.warmup &&
      this.armed &&
      flux > thr &&
      time - this.lastOnset >= o.refractory &&
      levelDb >= o.gateDb &&
      (minLevel === Infinity || levelDb - minLevel >= o.riseDb)
    ) {
      const excess = flux / thr - 1;
      strength = Math.min(1, 0.3 + 0.7 * (1 - Math.exp(-1.4 * excess)));
      this.lastOnset = time;
      this.armed = false;
    }

    this.times[this.head] = time;
    this.flux[this.head] = flux;
    this.levels[this.head] = levelDb;
    this.head = (this.head + 1) % CAPACITY;
    if (this.size < CAPACITY) this.size++;
    return strength;
  }

  /** Forget history, e.g. after a seek, so discontinuities do not read as transients. */
  reset(): void {
    this.head = 0;
    this.size = 0;
    this.lastOnset = -Infinity;
    this.armed = true;
    this.threshold = 0;
  }
}

export interface PeakPickOptions {
  /** frames before a candidate that must not exceed it */
  preMax: number;
  /** frames after a candidate that must not exceed it */
  postMax: number;
  /** frames before a candidate used for the local mean */
  preAvg: number;
  /** frames after a candidate used for the local mean */
  postAvg: number;
  /** candidate must exceed the local mean by this much */
  delta: number;
  /** absolute minimum value of a peak */
  minValue: number;
  /** minimum frames between peaks */
  wait: number;
}

/**
 * Non-causal peak picking (Böck/Dixon style) for offline analysis: a frame is an onset if
 * it is the local maximum, exceeds the local moving average by `delta` and respects the
 * minimum spacing. Returns frame indices in ascending order.
 */
export function pickPeaks(odf: Float32Array, o: PeakPickOptions): number[] {
  const n = odf.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + odf[i];
  const peaks: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = odf[i];
    if (v < o.minValue) continue;
    let isMax = true;
    const lo = Math.max(0, i - o.preMax);
    const hi = Math.min(n - 1, i + o.postMax);
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      // strict on the right, non-strict on the left: plateaus resolve to their first frame
      if (j < i ? odf[j] >= v : odf[j] > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    const a = Math.max(0, i - o.preAvg);
    const b = Math.min(n, i + o.postAvg + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    if (v < mean + o.delta) continue;
    if (i - last < o.wait) {
      // two peaks too close together: keep the stronger one
      if (v > odf[last]) {
        peaks[peaks.length - 1] = i;
        last = i;
      }
      continue;
    }
    peaks.push(i);
    last = i;
  }
  return peaks;
}

/** Approximate percentile of an array (subsampled for large inputs). */
export function percentile(values: Float32Array, q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const step = Math.max(1, Math.floor(n / 20000));
  const sample: number[] = [];
  for (let i = 0; i < n; i += step) sample.push(values[i]);
  sample.sort((x, y) => x - y);
  const idx = Math.min(sample.length - 1, Math.max(0, Math.round(q * (sample.length - 1))));
  return sample[idx];
}
