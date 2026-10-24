/**
 * Offline stand-in for the Web Audio AnalyserNode, fed from decoded PCM.
 *
 * It reproduces the analyser's output (Blackman window over the last `fftSize` samples,
 * |X[k]| / N in dB, smoothingTimeConstant 0) so the existing RealtimeAnalyzer and
 * AnalysisHub run unchanged during exports. Samples live in a ring buffer addressed by
 * absolute sample index, so memory stays bounded for tracks of any length.
 */
import type { SpectrumSource } from '../audio/analysis/RealtimeAnalyzer';
import type { AudioEngine } from '../audio/engine/AudioEngine';
import { FFT, blackmanWindow } from '../audio/dsp/fft';

export class PcmRing {
  readonly capacity: number;
  private readonly data: Float32Array;
  /** absolute index one past the last written sample */
  end = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  /** Write `samples` starting at absolute index `at` (gaps are zero-filled). */
  write(at: number, samples: Float32Array): void {
    if (at > this.end) {
      for (let i = this.end; i < at; i++) this.data[i % this.capacity] = 0;
    }
    for (let i = 0; i < samples.length; i++) this.data[(at + i) % this.capacity] = samples[i];
    this.end = Math.max(this.end, at + samples.length);
  }

  /** Sample at absolute index (0 outside the retained window). */
  at(index: number): number {
    if (index < 0 || index >= this.end || index < this.end - this.capacity) return 0;
    return this.data[index % this.capacity];
  }
}

export class PcmAnalyser implements SpectrumSource {
  readonly frequencyBinCount: number;
  /** absolute sample index the analysis window ends at */
  position = 0;
  private fft: FFT;
  private window: Float32Array;
  private readonly frame: Float32Array;
  private readonly mags: Float32Array;

  constructor(
    private readonly ring: PcmRing,
    readonly sampleRate: number,
    readonly fftSize = 2048,
  ) {
    this.frequencyBinCount = fftSize / 2;
    this.fft = new FFT(fftSize);
    this.window = blackmanWindow(fftSize);
    this.frame = new Float32Array(fftSize);
    this.mags = new Float32Array(fftSize / 2 + 1);
  }

  seek(time: number): void {
    this.position = Math.floor(time * this.sampleRate);
  }

  private fill(): void {
    const start = this.position - this.fftSize;
    for (let i = 0; i < this.fftSize; i++) this.frame[i] = this.ring.at(start + i);
  }

  getFloatFrequencyData(out: Float32Array): void {
    this.fill();
    this.fft.magnitudes(this.frame, 0, this.window, this.mags);
    for (let k = 0; k < out.length; k++) {
      const m = this.mags[k] / this.fftSize;
      out[k] = m > 0 ? 20 * Math.log10(m) : -Infinity;
    }
  }

  getFloatTimeDomainData(out: Float32Array): void {
    this.fill();
    out.set(this.frame.subarray(0, out.length));
  }
}

/**
 * A minimal AudioEngine look-alike whose clock is set by the renderer. AnalysisHub only
 * reads these members, which keeps the offline path on the exact same analysis code.
 */
export function virtualEngine(analyser: PcmAnalyser): { engine: AudioEngine; setTime: (t: number) => void } {
  let time = 0;
  const engine = {
    analyser,
    ctx: { sampleRate: analyser.sampleRate, outputLatency: 0, baseLatency: 0 },
    audio: { seeking: false },
    hasSource: true,
    isPlaying: true,
    readClock: () => time,
  };
  return {
    engine: engine as unknown as AudioEngine,
    setTime: (t) => {
      time = t;
      analyser.seek(t);
    },
  };
}
