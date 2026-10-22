import { FFT, blackmanWindow } from '../src/audio/dsp/fft';
import type { SpectrumSource } from '../src/audio/analysis/RealtimeAnalyzer';

/**
 * Emulates a Web Audio AnalyserNode (smoothingTimeConstant = 0) over a known signal:
 * the last `fftSize` samples before the current position, Blackman window, |X[k]| / N in dB.
 */
export class FakeAnalyser implements SpectrumSource {
  readonly frequencyBinCount: number;
  position = 0;
  private readonly fft: FFT;
  private readonly window: Float32Array;
  private readonly mags: Float32Array;

  constructor(
    private readonly signal: Float32Array,
    readonly sampleRate: number,
    readonly fftSize = 2048,
  ) {
    this.frequencyBinCount = fftSize / 2;
    this.fft = new FFT(fftSize);
    this.window = blackmanWindow(fftSize);
    this.mags = new Float32Array(fftSize / 2 + 1);
  }

  /** Move the read head to `time` seconds. */
  seek(time: number): void {
    this.position = Math.floor(time * this.sampleRate);
  }

  getFloatFrequencyData(out: Float32Array): void {
    this.fft.magnitudes(this.signal, this.position - this.fftSize, this.window, this.mags);
    for (let k = 0; k < out.length; k++) {
      const m = this.mags[k] / this.fftSize;
      out[k] = m > 0 ? 20 * Math.log10(m) : -Infinity;
    }
  }

  getFloatTimeDomainData(out: Float32Array): void {
    const start = this.position - this.fftSize;
    for (let i = 0; i < out.length; i++) {
      const idx = start + i;
      out[i] = idx >= 0 && idx < this.signal.length ? this.signal[idx] : 0;
    }
  }
}
