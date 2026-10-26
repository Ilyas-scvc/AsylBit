import type { EventTypeId } from '../dsp/events';

/** Number of log-spaced display bands exposed to the visual modes. */
export const DISPLAY_BANDS = 96;
/** Points in the down-sampled oscilloscope buffer. */
export const WAVE_POINTS = 256;
/** Length of the recent-event log shown in the HUD. */
export const EVENT_LOG_SIZE = 12;

export type EventSource = 'none' | 'realtime' | 'mapped';

/**
 * The single, mutable per-frame snapshot of the music that every renderer reads. It is
 * written once per animation frame by the AnalysisHub and never copied, so render loops
 * stay allocation-free. All values return to zero in silence and while paused.
 */
export interface AudioFrame {
  /** playback position in seconds (smoothed media clock) */
  time: number;
  /** seconds since the previous analysis tick */
  dt: number;
  /** monotonically increasing wall clock in seconds, for idle animation */
  clock: number;
  hasTrack: boolean;
  playing: boolean;
  /** 0..1, eases to 1 while music is audible and to 0 on pause / silence */
  activity: number;
  /** 0..1 loudness from RMS (absolute scale) */
  rms: number;
  rmsDb: number;
  /** smoothed band levels, sensitivity applied; nominal 0..1, may reach ~1.6 */
  sub: number;
  bass: number;
  mid: number;
  high: number;
  /** 0..1 overall spectral change */
  flux: number;
  /** decaying impulse envelopes triggered by detected events, 0..1 (scaled by beat impact) */
  kick: number;
  snare: number;
  hat: number;
  tone: number;
  /** event counters (monotonic) so renderers can react once per event */
  counts: Uint32Array;
  /** strength of the most recent event of each type */
  lastStrength: Float32Array;
  /**
   * Impulse value each type was set to when its most recent event fired (beat impact applied,
   * before any decay) — the same for every frame rate, unlike the decaying envelopes above.
   */
  lastPeak: Float32Array;
  /** playback time of the most recent event of each type (-1 if none) */
  lastTime: Float32Array;
  /** smoothed log-spectrum, DISPLAY_BANDS values 0..1 (low → high) */
  spectrum: Float32Array;
  /** slowly falling peak-hold of `spectrum` */
  peaks: Float32Array;
  /** oscilloscope, WAVE_POINTS samples in -1..1, gated by activity */
  waveform: Float32Array;
  /** which detector produced the events */
  eventSource: EventSource;
  /** ring buffer of recent events for the HUD */
  log: { type: Uint8Array; time: Float32Array; strength: Float32Array; head: number; size: number };
}

export function createAudioFrame(): AudioFrame {
  return {
    time: 0,
    dt: 0,
    clock: 0,
    hasTrack: false,
    playing: false,
    activity: 0,
    rms: 0,
    rmsDb: -200,
    sub: 0,
    bass: 0,
    mid: 0,
    high: 0,
    flux: 0,
    kick: 0,
    snare: 0,
    hat: 0,
    tone: 0,
    counts: new Uint32Array(4),
    lastStrength: new Float32Array(4),
    lastPeak: new Float32Array(4),
    lastTime: new Float32Array([-1, -1, -1, -1]),
    spectrum: new Float32Array(DISPLAY_BANDS),
    peaks: new Float32Array(DISPLAY_BANDS),
    waveform: new Float32Array(WAVE_POINTS),
    eventSource: 'none',
    log: {
      type: new Uint8Array(EVENT_LOG_SIZE),
      time: new Float32Array(EVENT_LOG_SIZE),
      strength: new Float32Array(EVENT_LOG_SIZE),
      head: 0,
      size: 0,
    },
  };
}

export function pushLog(frame: AudioFrame, type: EventTypeId, time: number, strength: number): void {
  const log = frame.log;
  log.type[log.head] = type;
  log.time[log.head] = time;
  log.strength[log.head] = strength;
  log.head = (log.head + 1) % EVENT_LOG_SIZE;
  if (log.size < EVENT_LOG_SIZE) log.size++;
}
