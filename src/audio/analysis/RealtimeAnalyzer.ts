/**
 * Real-time spectral analysis on top of an AnalyserNode (or any compatible source).
 *
 * Per animation frame it reads frequency- and time-domain data once and derives:
 *  - RMS loudness,
 *  - adaptive, attack/release-smoothed bass / mid / high levels,
 *  - a log-spaced display spectrum with frequency-dependent inertia,
 *  - per-band spectral flux and causal onset detection (kick / snare / hat / tone).
 *
 * Everything is allocated in `configure()`; `process()` does not allocate.
 */
import { AIR_BAND, BASS, BODY_BAND, HIGH, KICK_BAND, LogBandMapper, MID, SNAP_BAND, SUB, bandBins, powerToDb, type BinSpan } from '../dsp/bands';
import { attackRelease, clamp } from '../dsp/envelope';
import { AdaptiveOnsetTracker } from '../dsp/onset';
import { DISPLAY_BANDS, WAVE_POINTS } from './frame';

export interface SpectrumSource {
  readonly fftSize: number;
  readonly frequencyBinCount: number;
  getFloatFrequencyData(array: Float32Array<ArrayBuffer>): void;
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
}

export interface AnalyzerTuning {
  bassSensitivity: number;
  midSensitivity: number;
  highSensitivity: number;
  /** 0 = snappy, 1 = very smooth */
  smoothing: number;
}

/** Blackman-windowed AnalyserNode peak for a full-scale sine is ~0.21 (−13.5 dB). */
const ANALYSER_SINE_PEAK = 0.21;
const GAMMA = 100;
/** dB range of the adaptive level normalisation */
const LEVEL_RANGE = 30;
/** lowest reference the adaptive peak may fall to; keeps quiet passages from being blown up */
const PEAK_FLOOR_DB = -58;
const SPECTRUM_RANGE = 54;
/** spectra kept for the time-max reference */
const HISTORY = 8;
/** how far back (s) the flux reference looks */
const REF_WINDOW = 0.06;

class BandLevel {
  peakDb = PEAK_FLOOR_DB;
  value = 0;

  update(db: number, dt: number, attack: number, release: number): number {
    // fast-rising, slowly falling reference = automatic gain for this band
    this.peakDb = Math.max(db, this.peakDb - 4 * dt, PEAK_FLOOR_DB);
    const norm = clamp((db - (this.peakDb - LEVEL_RANGE)) / LEVEL_RANGE, 0, 1);
    const shaped = norm * norm * (3 - 2 * norm); // smoothstep: quiet stays quiet, peaks pop
    this.value = attackRelease(this.value, shaped, dt, attack, release);
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.peakDb = PEAK_FLOOR_DB;
  }
}

export interface FrameOnsets {
  kick: number;
  snare: number;
  hat: number;
  tone: number;
}

export class RealtimeAnalyzer {
  fftSize = 0;
  sampleRate = 0;

  // ---- outputs -------------------------------------------------------------------------
  rmsDb = -200;
  rms = 0;
  sub = 0;
  bass = 0;
  mid = 0;
  high = 0;
  flux = 0;
  readonly spectrum = new Float32Array(DISPLAY_BANDS);
  readonly peaks = new Float32Array(DISPLAY_BANDS);
  readonly waveform = new Float32Array(WAVE_POINTS);
  readonly onsets: FrameOnsets = { kick: 0, snare: 0, hat: 0, tone: 0 };

  // ---- working buffers -----------------------------------------------------------------
  private freqDb = new Float32Array(0);
  private timeData = new Float32Array(0);
  private power = new Float32Array(0);
  private logMag = new Float32Array(0);
  private refLog = new Float32Array(0);
  private history: Float32Array[] = [];
  private readonly historyTime = new Float64Array(HISTORY);
  private histHead = 0;
  private histCount = 0;
  private hasPrev = false;
  private displayPower = new Float32Array(DISPLAY_BANDS);
  private displaySens = new Float32Array(DISPLAY_BANDS);
  private displayTilt = new Float32Array(DISPLAY_BANDS);
  private displayRelease = new Float32Array(DISPLAY_BANDS);
  private displayAttack = new Float32Array(DISPLAY_BANDS);
  private displayCenters = new Float32Array(DISPLAY_BANDS);
  private mapper: LogBandMapper | null = null;
  private spectrumPeakDb = -40;
  private fluxPeak = 0.3;
  private kickPeak = 0.3;

  private spans!: Record<'kick' | 'body' | 'snap' | 'air' | 'sub' | 'bass' | 'mid' | 'high', BinSpan>;
  private readonly levels = { sub: new BandLevel(), bass: new BandLevel(), mid: new BandLevel(), high: new BandLevel() };

  private readonly kickTracker = new AdaptiveOnsetTracker({
    window: 1.0, lambda: 2, mu: 0.5, floor: 0.18, refractory: 0.11, riseDb: 3, riseWindow: 0.12, gateDb: -60, rearm: 0.5, warmup: 6,
  });
  private readonly snareTracker = new AdaptiveOnsetTracker({
    window: 1.0, lambda: 2, mu: 0.5, floor: 0.06, refractory: 0.1, riseDb: 3, riseWindow: 0.1, gateDb: -66, rearm: 0.5, warmup: 6,
  });
  private readonly hatTracker = new AdaptiveOnsetTracker({
    window: 0.8, lambda: 2, mu: 0.5, floor: 0.06, refractory: 0.055, riseDb: 2.5, riseWindow: 0.08, gateDb: -74, rearm: 0.5, warmup: 6,
  });
  private readonly toneTracker = new AdaptiveOnsetTracker({
    window: 1.0, lambda: 2.5, mu: 0.8, floor: 0.08, refractory: 0.12, riseDb: 3, riseWindow: 0.12, gateDb: -60, rearm: 0.5, warmup: 6,
  });
  private lastDrumTime = -Infinity;
  private lastSnareTime = -Infinity;

  /** (Re)allocate for a given analyser configuration. Cheap no-op if unchanged. */
  configure(fftSize: number, sampleRate: number): void {
    if (fftSize === this.fftSize && sampleRate === this.sampleRate) return;
    this.fftSize = fftSize;
    this.sampleRate = sampleRate;
    const bins = fftSize / 2;
    this.freqDb = new Float32Array(bins);
    this.timeData = new Float32Array(fftSize);
    this.power = new Float32Array(bins);
    this.logMag = new Float32Array(bins);
    this.refLog = new Float32Array(bins);
    this.history = Array.from({ length: HISTORY }, () => new Float32Array(bins));
    this.hasPrev = false;
    const span = (r: { lo: number; hi: number }) => bandBins(r, sampleRate, fftSize);
    this.spans = {
      kick: span(KICK_BAND),
      body: span(BODY_BAND),
      snap: span(SNAP_BAND),
      air: span(AIR_BAND),
      sub: span(SUB),
      bass: span(BASS),
      mid: span(MID),
      high: span(HIGH),
    };
    this.mapper = new LogBandMapper(DISPLAY_BANDS, 30, 16000, sampleRate, fftSize);
    for (let i = 0; i < DISPLAY_BANDS; i++) {
      const fc = this.mapper.centers[i];
      this.displayCenters[i] = fc;
      // +3 dB/oct tilt so a typical mix (which falls off toward the highs) reads as balanced
      this.displayTilt[i] = 3 * Math.log2(fc / 1000);
      const t = i / (DISPLAY_BANDS - 1);
      // lows: large and slow; highs: small and fast
      this.displayRelease[i] = 0.32 - 0.24 * t;
      this.displayAttack[i] = 0.035 - 0.027 * t;
    }
    this.resetDetection();
  }

  /** Clear onset history and smoothing; call after seeks, track changes or FFT changes. */
  resetDetection(): void {
    this.hasPrev = false;
    this.histCount = 0;
    this.kickTracker.reset();
    this.snareTracker.reset();
    this.hatTracker.reset();
    this.toneTracker.reset();
    this.lastDrumTime = -Infinity;
    this.lastSnareTime = -Infinity;
  }

  /** Full reset including levels (new track). */
  resetAll(): void {
    this.resetDetection();
    this.levels.sub.reset();
    this.levels.bass.reset();
    this.levels.mid.reset();
    this.levels.high.reset();
    this.spectrum.fill(0);
    this.peaks.fill(0);
    this.waveform.fill(0);
    this.sub = this.bass = this.mid = this.high = this.flux = this.rms = 0;
    this.rmsDb = -200;
    this.fluxPeak = 0.3;
    this.kickPeak = 0.3;
    this.spectrumPeakDb = -40;
  }

  private sensitivityAt(hz: number, t: AnalyzerTuning): number {
    // smooth crossfade between the three sensitivity controls in log-frequency
    const lx = Math.log2(hz);
    const a = clamp((lx - Math.log2(110)) / (Math.log2(220) - Math.log2(110)), 0, 1);
    const b = clamp((lx - Math.log2(1500)) / (Math.log2(3000) - Math.log2(1500)), 0, 1);
    const lowMid = t.bassSensitivity + (t.midSensitivity - t.bassSensitivity) * a;
    return lowMid + (t.highSensitivity - lowMid) * b;
  }

  /**
   * Analyse one frame. `detect` enables the real-time onset detectors (disabled when a
   * pre-computed event map drives the visuals, or while paused / seeking).
   */
  process(source: SpectrumSource, time: number, dt: number, tuning: AnalyzerTuning, detect: boolean): void {
    if (source.fftSize !== this.fftSize) return;
    const { freqDb, timeData, power, logMag, refLog, spans } = this;
    const bins = this.fftSize / 2;
    source.getFloatFrequencyData(freqDb);
    source.getFloatTimeDomainData(timeData);

    // ---- loudness ----------------------------------------------------------------------
    let sq = 0;
    for (let i = 0; i < timeData.length; i++) sq += timeData[i] * timeData[i];
    const rms = Math.sqrt(sq / timeData.length);
    this.rmsDb = rms > 1e-10 ? 20 * Math.log10(rms) : -200;
    this.rms = attackRelease(this.rms, clamp((this.rmsDb + 60) / 54, 0, 1), dt, 0.02, 0.25);

    // ---- spectrum → power + log magnitude ----------------------------------------------
    const invPeak = 1 / ANALYSER_SINE_PEAK;
    for (let k = 0; k < bins; k++) {
      const db = freqDb[k];
      if (db > -180 && db < 100) {
        const m = Math.pow(10, db / 20) * invPeak;
        power[k] = m * m;
        logMag[k] = Math.log1p(GAMMA * m);
      } else {
        power[k] = 0;
        logMag[k] = 0;
      }
    }

    const meanPower = (s: BinSpan) => {
      let acc = 0;
      for (let k = s.start; k < s.end; k++) acc += power[k];
      return acc / (s.end - s.start);
    };

    // Reference spectrum = per-bin maximum over the last ~60 ms (time-domain max filter).
    // A level that dips and comes back (e.g. a kick tail beating against a held bass) is
    // compared with its own recent crest, so it does not read as a new attack.
    if (this.hasPrev) {
      refLog.set(this.history[this.histHead]);
      for (let h = 1; h < this.histCount; h++) {
        const idx = (this.histHead - h + HISTORY) % HISTORY;
        if (time - this.historyTime[idx] > REF_WINDOW) break;
        const past = this.history[idx];
        for (let k = 0; k < bins; k++) if (past[k] > refLog[k]) refLog[k] = past[k];
      }
    }
    const fluxOf = (s: BinSpan) => {
      if (!this.hasPrev) return 0;
      let acc = 0;
      for (let k = s.start; k < s.end; k++) {
        const prev = Math.max(refLog[k > 0 ? k - 1 : k], refLog[k], refLog[k + 1 < bins ? k + 1 : k]);
        const d = logMag[k] - prev;
        if (d > 0) acc += d;
      }
      return acc / (s.end - s.start);
    };

    // ---- band levels -------------------------------------------------------------------
    const release = 0.06 + tuning.smoothing * 0.5;
    const attack = 0.008 + tuning.smoothing * 0.03;
    const subDb = powerToDb(meanPower(spans.sub));
    const bassDb = powerToDb(meanPower(spans.bass));
    const midDb = powerToDb(meanPower(spans.mid));
    const highDb = powerToDb(meanPower(spans.high));
    this.sub = Math.min(1.6, this.levels.sub.update(subDb, dt, attack, release * 1.3) * tuning.bassSensitivity);
    this.bass = Math.min(1.6, this.levels.bass.update(bassDb, dt, attack, release * 1.15) * tuning.bassSensitivity);
    this.mid = Math.min(1.6, this.levels.mid.update(midDb, dt, attack, release) * tuning.midSensitivity);
    this.high = Math.min(1.6, this.levels.high.update(highDb, dt, attack * 0.6, release * 0.7) * tuning.highSensitivity);

    // ---- display spectrum --------------------------------------------------------------
    const mapper = this.mapper!;
    mapper.map(power, this.displayPower);
    let frameMax = -200;
    for (let i = 0; i < DISPLAY_BANDS; i++) {
      const db = powerToDb(this.displayPower[i]) + this.displayTilt[i];
      this.displayPower[i] = db; // reuse as dB scratch
      if (db > frameMax) frameMax = db;
    }
    this.spectrumPeakDb = Math.max(frameMax, this.spectrumPeakDb - 3 * dt, PEAK_FLOOR_DB + 10);
    const smoothScale = 0.5 + tuning.smoothing;
    for (let i = 0; i < DISPLAY_BANDS; i++) {
      const norm = clamp((this.displayPower[i] - (this.spectrumPeakDb - SPECTRUM_RANGE)) / SPECTRUM_RANGE, 0, 1);
      this.displaySens[i] = this.sensitivityAt(this.displayCenters[i], tuning);
      const target = Math.min(1.25, norm * norm * this.displaySens[i]);
      this.spectrum[i] = attackRelease(this.spectrum[i], target, dt, this.displayAttack[i], this.displayRelease[i] * smoothScale);
      const p = this.peaks[i] - dt * 0.5;
      this.peaks[i] = this.spectrum[i] > p ? this.spectrum[i] : p > 0 ? p : 0;
    }

    // ---- oscilloscope (aligned to a rising zero crossing for a stable picture) ----------
    const stride = Math.max(1, Math.floor(timeData.length / 2 / WAVE_POINTS));
    let start = 0;
    const searchEnd = timeData.length - WAVE_POINTS * stride - 1;
    for (let i = 1; i < searchEnd; i++) {
      if (timeData[i - 1] < 0 && timeData[i] >= 0) {
        start = i;
        break;
      }
    }
    for (let i = 0; i < WAVE_POINTS; i++) {
      const v = timeData[start + i * stride] ?? 0;
      this.waveform[i] = v;
    }

    // ---- flux + onsets -----------------------------------------------------------------
    const kickFlux = fluxOf(spans.kick);
    const bodyFlux = fluxOf(spans.body);
    const snapFlux = fluxOf(spans.snap);
    const airFlux = fluxOf(spans.air);
    const total = kickFlux + 0.6 * bodyFlux + 0.6 * snapFlux + 0.4 * airFlux;
    this.fluxPeak = Math.max(total, this.fluxPeak * Math.exp(-dt / 4), 0.25);
    this.flux = attackRelease(this.flux, clamp(total / this.fluxPeak, 0, 1), dt, 0.01, 0.12);

    const on = this.onsets;
    on.kick = on.snare = on.hat = on.tone = 0;
    if (detect && this.hasPrev) {
      const kickDb = powerToDb(meanPower(spans.kick));
      const snapDb = powerToDb(meanPower(spans.snap));
      const airDb = powerToDb(meanPower(spans.air));
      const bodyDb = powerToDb(meanPower(spans.body));

      // Kick: low-band flux onset with a real level rise (checked in the tracker), at least
      // a fraction of recent kick strength, and spread across the band. Vetoes are decided
      // before the tracker commits, so a rejected frame cannot block the next one.
      let rising = 0;
      for (let k = spans.kick.start; k < spans.kick.end; k++) if (logMag[k] - refLog[k] > 0.3) rising++;
      const spread = rising / (spans.kick.end - spans.kick.start);
      const kickOk = kickFlux >= 0.45 * this.kickPeak && spread >= 0.3;
      const kick = this.kickTracker.push(time, kickFlux, kickDb, kickOk);
      this.kickPeak = Math.max(kick > 0 ? Math.min(kickFlux, this.kickPeak * 2.5) : 0, this.kickPeak * Math.exp(-dt / 3), 0.15);

      // Snare: snap transient that is broadband — the body band moves with it. At the
      // playback rate the air band reaches 14 kHz, so the snap/air ratio is looser than offline.
      const snareOk = bodyFlux >= 0.05 && bodyFlux >= 0.2 * snapFlux && snapFlux >= 0.35 * airFlux;
      const snare = this.snareTracker.push(time, snapFlux, snapDb, snareOk);
      if (snare > 0) this.lastSnareTime = time;

      // Hat: air-band transient that is not part of (or the tail of) a snare.
      const hat = this.hatTracker.push(time, airFlux, airDb, time - this.lastSnareTime >= 0.06);

      // Tone: body-band attack that is not the click of a drum hit.
      if (kick > 0 || snare > 0) this.lastDrumTime = time;
      const tone = this.toneTracker.push(time, bodyFlux, bodyDb, time - this.lastDrumTime >= 0.05);

      on.kick = kick;
      on.snare = snare;
      on.hat = hat;
      on.tone = tone * 0.8;
    }

    // remember this spectrum for the time-max reference of the next frames
    this.histHead = (this.histHead + 1) % HISTORY;
    this.history[this.histHead].set(logMag);
    this.historyTime[this.histHead] = time;
    if (this.histCount < HISTORY) this.histCount++;
    this.hasPrev = true;
  }
}
