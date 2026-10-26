/**
 * Glue between the playback engine, the real-time analyzer, the pre-computed event map
 * and the renderers. `tick()` is called from the render loop(s); it is idempotent within
 * one animation frame, so the WebGL scene and the DOM HUD can both call it safely.
 *
 * Latency compensation: the analyser and the media clock run ahead of the speakers by the
 * audio output latency (≈10–60 ms on wired outputs, often 150–250 ms on Bluetooth).
 * Analysis results pass through a short delay line and mapped events are compared with
 * the *audible* position, so what you see lines up with what you hear.
 */
import type { AudioEngine } from '../engine/AudioEngine';
import { EventType, type EventMap, type EventTypeId } from '../dsp/events';
import { attackRelease, clamp, decay } from '../dsp/envelope';
import { EventScheduler } from './EventScheduler';
import { createAudioFrame, DISPLAY_BANDS, pushLog, WAVE_POINTS, type AudioFrame } from './frame';
import { RealtimeAnalyzer, type AnalyzerTuning } from './RealtimeAnalyzer';

export interface HubTuning extends AnalyzerTuning {
  beatImpact: number;
  reducedMotion: boolean;
  /** multiplier for the impulse decay times (1 = default) */
  decay?: number;
}

/** Display pipeline delay (render + composite) that already offsets part of the audio latency. */
const DISPLAY_LATENCY = 0.02;
export const MAX_COMPENSATION = 0.4;
/** tick() ignores calls closer together than this, so it runs at most 250 times a second */
const MIN_TICK_MS = 4;
/**
 * The delay line must still hold a result that is MAX_COMPENSATION old at the fastest tick
 * rate (≈ 100 slots at 250 Hz; a 240 Hz display needs 96). Bounded: ~1.8 KB per slot.
 */
export const DELAY_SLOTS = Math.ceil((MAX_COMPENSATION * 1000) / MIN_TICK_MS) + 28;

interface Slot {
  wall: number;
  media: number;
  rms: number;
  rmsDb: number;
  sub: number;
  bass: number;
  mid: number;
  high: number;
  flux: number;
  spectrum: Float32Array;
  peaks: Float32Array;
  waveform: Float32Array;
  /** real-time onset strengths: kick, snare, hat, tone */
  onsets: Float32Array;
}

function makeSlot(): Slot {
  return {
    wall: -Infinity,
    media: 0,
    rms: 0,
    rmsDb: -200,
    sub: 0,
    bass: 0,
    mid: 0,
    high: 0,
    flux: 0,
    spectrum: new Float32Array(DISPLAY_BANDS),
    peaks: new Float32Array(DISPLAY_BANDS),
    waveform: new Float32Array(WAVE_POINTS),
    onsets: new Float32Array(4),
  };
}

export class AnalysisHub {
  readonly frame: AudioFrame = createAudioFrame();
  readonly analyzer = new RealtimeAnalyzer();
  private readonly scheduler = new EventScheduler();
  private engine: AudioEngine | null = null;
  private lastNow = 0;
  private readonly slots: Slot[] = Array.from({ length: DELAY_SLOTS }, makeSlot);
  private head = -1;
  private consumed = -1;
  /** current latency compensation in seconds (exposed for the HUD / tests) */
  latency = 0;
  private tuning: HubTuning = {
    bassSensitivity: 1,
    midSensitivity: 1,
    highSensitivity: 1,
    smoothing: 0.45,
    beatImpact: 1,
    reducedMotion: false,
  };

  attach(engine: AudioEngine): void {
    this.engine = engine;
  }

  setTuning(t: HubTuning): void {
    this.tuning = t;
  }

  /** Use a pre-computed event map (or null to fall back to real-time detection). */
  setEventMap(map: EventMap | null): void {
    this.scheduler.setMap(map, this.frame.time);
    this.analyzer.resetDetection();
    this.dropPendingOnsets();
  }

  get usingMap(): boolean {
    return this.scheduler.hasMap;
  }

  /** Seek: never fire events from the skipped region, forget detection history. */
  onSeek(time: number): void {
    this.scheduler.reset(time);
    this.analyzer.resetDetection();
    this.dropPendingOnsets();
    this.frame.time = time;
  }

  /** New track: drop everything that belonged to the previous one. */
  onTrackChange(): void {
    this.scheduler.setMap(null, 0);
    this.analyzer.resetAll();
    this.dropPendingOnsets();
    const f = this.frame;
    f.kick = f.snare = f.hat = f.tone = 0;
    f.log.size = 0;
    f.log.head = 0;
    f.lastTime.fill(-1);
    f.lastPeak.fill(0);
    f.time = 0;
  }

  private dropPendingOnsets(): void {
    for (const s of this.slots) s.onsets.fill(0);
  }

  private readonly fire = (type: EventTypeId, strength: number, at: number): void => {
    const f = this.frame;
    const impact = this.tuning.beatImpact * (this.tuning.reducedMotion ? 0.4 : 1);
    const s = clamp(strength * impact, 0, 1.5);
    switch (type) {
      case EventType.KICK:
        f.kick = Math.max(f.kick, s);
        break;
      case EventType.SNARE:
        f.snare = Math.max(f.snare, s);
        break;
      case EventType.HAT:
        f.hat = Math.max(f.hat, s);
        break;
      default:
        f.tone = Math.max(f.tone, s);
    }
    f.counts[type]++;
    f.lastStrength[type] = strength;
    f.lastPeak[type] = s;
    f.lastTime[type] = at;
    pushLog(f, type, at, strength);
  };

  private exportMode = false;

  /**
   * While recording a video the audio is captured at the analyser, before the speakers,
   * so visuals must not be delayed by the output latency.
   */
  setExportMode(on: boolean): void {
    this.exportMode = on;
  }

  private estimateLatency(ctx: AudioContext | null): number {
    if (!ctx || this.exportMode) return 0;
    const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
    return clamp(out + base - DISPLAY_LATENCY, 0, MAX_COMPENSATION);
  }

  /** Run one analysis step. `now` is a performance.now()-style timestamp in ms. */
  tick(now: number): void {
    if (this.lastNow !== 0 && now - this.lastNow < MIN_TICK_MS) return;
    const dt = this.lastNow === 0 ? 1 / 60 : clamp((now - this.lastNow) / 1000, 0, 0.1);
    this.lastNow = now;
    const f = this.frame;
    f.dt = dt;
    f.clock += dt;

    const e = this.engine;
    const analyser = e?.analyser ?? null;
    f.hasTrack = !!e?.hasSource;
    const playing = !!e && e.isPlaying && !e.audio.seeking;
    f.playing = playing;
    const latency = (this.latency = this.estimateLatency(e?.ctx ?? null));
    const media = e ? e.readClock() : 0;
    f.time = Math.max(0, media - (playing ? latency : 0));

    const a = this.analyzer;
    if (analyser && e?.ctx) {
      a.configure(analyser.fftSize, e.ctx.sampleRate);
      a.process(analyser, media, dt, this.tuning, playing && !this.scheduler.hasMap);
      // write into the delay line …
      this.head = (this.head + 1) % DELAY_SLOTS;
      const w = this.slots[this.head];
      w.wall = now;
      w.media = media;
      w.rms = a.rms;
      w.rmsDb = a.rmsDb;
      w.sub = a.sub;
      w.bass = a.bass;
      w.mid = a.mid;
      w.high = a.high;
      w.flux = a.flux;
      w.spectrum.set(a.spectrum);
      w.peaks.set(a.peaks);
      w.waveform.set(a.waveform);
      w.onsets[0] = a.onsets.kick;
      w.onsets[1] = a.onsets.snare;
      w.onsets[2] = a.onsets.hat;
      w.onsets[3] = a.onsets.tone;
      // … and read the newest slot that is old enough to be audible now
      const due = now - latency * 1000;
      let pick = -1;
      for (let i = 0; i < DELAY_SLOTS; i++) {
        const idx = (this.head - i + DELAY_SLOTS) % DELAY_SLOTS;
        if (this.slots[idx].wall <= due) {
          pick = idx;
          break;
        }
      }
      if (pick >= 0) {
        const r = this.slots[pick];
        f.rms = r.rms;
        f.rmsDb = r.rmsDb;
        f.sub = r.sub;
        f.bass = r.bass;
        f.mid = r.mid;
        f.high = r.high;
        f.flux = r.flux;
        f.spectrum.set(r.spectrum);
        f.peaks.set(r.peaks);
        f.waveform.set(r.waveform);
        // real-time onsets of every slot passed since the last read
        if (this.consumed !== pick) {
          let idx = this.consumed < 0 ? pick : (this.consumed + 1) % DELAY_SLOTS;
          for (let guard = 0; guard < DELAY_SLOTS; guard++) {
            const s = this.slots[idx];
            if (playing && !this.scheduler.hasMap) {
              if (s.onsets[0] > 0) this.fire(EventType.KICK, s.onsets[0], s.media);
              if (s.onsets[1] > 0) this.fire(EventType.SNARE, s.onsets[1], s.media);
              if (s.onsets[2] > 0) this.fire(EventType.HAT, s.onsets[2], s.media);
              if (s.onsets[3] > 0) this.fire(EventType.TONE, s.onsets[3], s.media);
            }
            s.onsets.fill(0);
            if (idx === pick) break;
            idx = (idx + 1) % DELAY_SLOTS;
          }
          this.consumed = pick;
        }
      }
    } else {
      // no audio graph yet (nothing played): everything rests
      f.rms = decay(f.rms, dt, 0.2);
      f.sub = decay(f.sub, dt, 0.2);
      f.bass = decay(f.bass, dt, 0.2);
      f.mid = decay(f.mid, dt, 0.2);
      f.high = decay(f.high, dt, 0.2);
      f.flux = decay(f.flux, dt, 0.2);
      for (let i = 0; i < DISPLAY_BANDS; i++) {
        f.spectrum[i] = decay(f.spectrum[i], dt, 0.2);
        f.peaks[i] = decay(f.peaks[i], dt, 0.3);
      }
      for (let i = 0; i < WAVE_POINTS; i++) f.waveform[i] *= 0.8;
    }

    // ---- mapped events: compared with the audible playback position ---------------------
    if (playing) {
      if (this.scheduler.hasMap) {
        f.eventSource = 'mapped';
        this.scheduler.advance(f.time, this.fire);
      } else {
        f.eventSource = 'realtime';
      }
    } else {
      // Keep the cursor glued to the playhead so resuming never replays old events. On
      // resume the audible time starts `latency` behind it, and the scheduler waits.
      this.scheduler.reset(media);
      if (!f.hasTrack) f.eventSource = 'none';
    }

    const slow = (this.tuning.reducedMotion ? 1.7 : 1) * (this.tuning.decay ?? 1);
    f.kick = decay(f.kick, dt, 0.17 * slow);
    f.snare = decay(f.snare, dt, 0.22 * slow);
    f.hat = decay(f.hat, dt, 0.07 * slow);
    f.tone = decay(f.tone, dt, 0.25 * slow);

    const audible = playing && f.rmsDb > -58;
    f.activity = attackRelease(f.activity, audible ? 1 : 0, dt, 0.12, 0.7);
  }
}

export const analysisHub = new AnalysisHub();
