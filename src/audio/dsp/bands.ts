/** Frequency band helpers that adapt to the actual sample rate and FFT size. */

export interface BandRange {
  lo: number;
  hi: number;
}

/** The three musical bands exposed to the visuals (approximate, per the brief). */
export const SUB: BandRange = { lo: 20, hi: 60 };
export const BASS: BandRange = { lo: 20, hi: 150 };
export const MID: BandRange = { lo: 150, hi: 2000 };
export const HIGH: BandRange = { lo: 2000, hi: 12000 };

/** Narrower detection bands used by the kick / snare / hat heuristics. */
export const KICK_BAND: BandRange = { lo: 35, hi: 140 };
/** snare body and most tonal attacks; starts above a kick's pitch sweep */
export const BODY_BAND: BandRange = { lo: 250, hi: 2500 };
/** snare / clap "crack" */
export const SNAP_BAND: BandRange = { lo: 2500, hi: 6500 };
/** hats, shakers, cymbal ticks */
export const AIR_BAND: BandRange = { lo: 7000, hi: 14000 };

export function binWidth(sampleRate: number, fftSize: number): number {
  return sampleRate / fftSize;
}

/** Fractional bin index for a frequency. */
export function hzToBin(hz: number, sampleRate: number, fftSize: number): number {
  return (hz * fftSize) / sampleRate;
}

export function binToHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize;
}

export interface BinSpan {
  /** inclusive */
  start: number;
  /** exclusive */
  end: number;
}

/**
 * Integer bin span covering a band. Never includes the DC bin, is clamped to Nyquist and
 * always contains at least one bin, so tiny bands still work at coarse FFT resolutions.
 */
export function bandBins(range: BandRange, sampleRate: number, fftSize: number): BinSpan {
  const binCount = fftSize / 2;
  const nyquist = sampleRate / 2;
  const hi = Math.min(range.hi, nyquist * 0.98);
  const lo = Math.min(range.lo, hi);
  let start = Math.max(1, Math.round(hzToBin(lo, sampleRate, fftSize)));
  let end = Math.min(binCount, Math.round(hzToBin(hi, sampleRate, fftSize)) + 1);
  if (start >= binCount) start = binCount - 1;
  if (end <= start) end = start + 1;
  return { start, end };
}

/**
 * Maps a linear FFT power spectrum to `count` logarithmically spaced display bands.
 * Bands narrower than one FFT bin are linearly interpolated instead of duplicated,
 * so the bass end stays smooth even at small FFT sizes.
 */
export class LogBandMapper {
  readonly count: number;
  readonly centers: Float32Array;
  private readonly starts: Int32Array;
  private readonly ends: Int32Array;
  private readonly fractional: Float32Array;

  constructor(count: number, minHz: number, maxHz: number, sampleRate: number, fftSize: number) {
    this.count = count;
    this.centers = new Float32Array(count);
    this.starts = new Int32Array(count);
    this.ends = new Int32Array(count);
    this.fractional = new Float32Array(count);
    const binCount = fftSize / 2;
    const top = Math.min(maxHz, sampleRate * 0.49);
    const ratio = Math.log(top / minHz);
    for (let i = 0; i < count; i++) {
      const loHz = minHz * Math.exp((ratio * i) / count);
      const hiHz = minHz * Math.exp((ratio * (i + 1)) / count);
      const centerHz = Math.sqrt(loHz * hiHz);
      this.centers[i] = centerHz;
      const loBin = hzToBin(loHz, sampleRate, fftSize);
      const hiBin = hzToBin(hiHz, sampleRate, fftSize);
      const s = Math.max(1, Math.ceil(loBin));
      const e = Math.min(binCount - 1, Math.floor(hiBin));
      if (e >= s) {
        this.starts[i] = s;
        this.ends[i] = e + 1;
        this.fractional[i] = -1;
      } else {
        this.starts[i] = -1;
        this.ends[i] = -1;
        this.fractional[i] = Math.min(binCount - 1.001, Math.max(1, hzToBin(centerHz, sampleRate, fftSize)));
      }
    }
  }

  /** `power` is the linear power spectrum (|X|^2), `out` receives mean power per band. */
  map(power: Float32Array, out: Float32Array): void {
    for (let i = 0; i < this.count; i++) {
      const f = this.fractional[i];
      if (f >= 0) {
        const k = Math.floor(f);
        const t = f - k;
        out[i] = power[k] * (1 - t) + power[k + 1] * t;
      } else {
        let sum = 0;
        const s = this.starts[i];
        const e = this.ends[i];
        for (let k = s; k < e; k++) sum += power[k];
        out[i] = sum / (e - s);
      }
    }
  }
}

export function powerToDb(power: number): number {
  return power > 1e-20 ? 10 * Math.log10(power) : -200;
}
