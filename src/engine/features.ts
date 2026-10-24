/**
 * AudioFeatureProvider: turns the shared AudioFrame (one analysis for the whole app) into
 * the SceneAudio a scene sees, applying that scene's Audio Reaction settings: noise gate,
 * per-band sensitivity (sub / bass / mids / treble), kick & snare impact and transient
 * sensitivity. Stateless per frame, so live and offline rendering agree exactly.
 */
import type { AudioFrame } from '../audio/analysis/frame';
import { DISPLAY_BANDS, WAVE_POINTS } from '../audio/analysis/frame';
import { EventType } from '../audio/dsp/events';
import type { ParamReader, SceneAudio } from './types';

export function createSceneAudio(): SceneAudio {
  return {
    time: 0,
    playing: false,
    hasTrack: false,
    activity: 0,
    sub: 0,
    bass: 0,
    mids: 0,
    treble: 0,
    rms: 0,
    flux: 0,
    kick: 0,
    snare: 0,
    hat: 0,
    tone: 0,
    kickCount: 0,
    snareCount: 0,
    hatCount: 0,
    spectrum: new Float32Array(DISPLAY_BANDS),
    peaks: new Float32Array(DISPLAY_BANDS),
    waveform: new Float32Array(WAVE_POINTS),
  };
}

/** Centre frequency (Hz) of each display band: log-spaced 30 Hz … 16 kHz. */
export const BAND_CENTERS: Float32Array = (() => {
  const out = new Float32Array(DISPLAY_BANDS);
  const ratio = Math.log(16000 / 30);
  for (let i = 0; i < DISPLAY_BANDS; i++) out[i] = 30 * Math.exp((ratio * (i + 0.5)) / DISPLAY_BANDS);
  return out;
})();

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Weight of each sensitivity control for a frequency (smooth crossfades in log-frequency). */
export function bandWeights(hz: number): [sub: number, bass: number, mids: number, treble: number] {
  const l = Math.log2(hz);
  const toBass = smoothstep(Math.log2(50), Math.log2(80), l);
  const toMids = smoothstep(Math.log2(120), Math.log2(220), l);
  const toTreble = smoothstep(Math.log2(1500), Math.log2(3000), l);
  return [(1 - toBass), toBass * (1 - toMids), toMids * (1 - toTreble), toTreble];
}

const WEIGHTS = Array.from(BAND_CENTERS, (hz) => bandWeights(hz));

/** dB level at which the noise gate opens for a gate setting 0..1. */
export function gateThresholdDb(gate: number): number {
  return -90 + Math.min(1, Math.max(0, gate)) * 60;
}

/** Shape an impulse by transient sensitivity: below 1 weak hits fade out, above 1 they grow. */
export function shapeTransient(value: number, sensitivity: number): number {
  if (value <= 0) return 0;
  const s = Math.max(0, sensitivity);
  // soft knee: the lower the sensitivity, the more a weak impulse is suppressed
  const knee = Math.max(0, 1 - s) * 0.35;
  const v = value <= knee ? 0 : (value - knee) / (1 - knee);
  return Math.min(1.5, v * Math.max(0.25, s));
}

export class AudioFeatureProvider {
  readonly out: SceneAudio = createSceneAudio();

  build(frame: AudioFrame, p: ParamReader): SceneAudio {
    const o = this.out;
    const gate = p.num('noiseGate');
    // the gate closes smoothly over 8 dB so it never pumps
    const g = gate <= 0 ? 1 : smoothstep(gateThresholdDb(gate) - 6, gateThresholdDb(gate) + 2, frame.rmsDb);
    const sSub = p.num('subBass');
    const sBass = p.num('bass');
    const sMids = p.num('mids');
    const sTreble = p.num('treble');
    const ts = p.num('transientSensitivity');

    o.time = frame.time;
    o.playing = frame.playing;
    o.hasTrack = frame.hasTrack;
    o.activity = frame.activity * g;
    o.sub = Math.min(1.6, frame.sub * sSub * g);
    o.bass = Math.min(1.6, frame.bass * sBass * g);
    o.mids = Math.min(1.6, frame.mid * sMids * g);
    o.treble = Math.min(1.6, frame.high * sTreble * g);
    o.rms = frame.rms * g;
    o.flux = frame.flux * g;
    o.kick = shapeTransient(frame.kick, ts) * p.num('kickImpact') * g;
    o.snare = shapeTransient(frame.snare, ts) * p.num('snareImpact') * g;
    o.hat = shapeTransient(frame.hat, ts) * g;
    o.tone = shapeTransient(frame.tone, ts) * g;
    o.kickCount = frame.counts[EventType.KICK];
    o.snareCount = frame.counts[EventType.SNARE];
    o.hatCount = frame.counts[EventType.HAT];
    for (let i = 0; i < DISPLAY_BANDS; i++) {
      const w = WEIGHTS[i];
      const k = (w[0] * sSub + w[1] * sBass + w[2] * sMids + w[3] * sTreble) * g;
      o.spectrum[i] = Math.min(1.25, frame.spectrum[i] * k);
      o.peaks[i] = Math.min(1.25, frame.peaks[i] * k);
    }
    o.waveform.set(frame.waveform);
    if (g < 1) for (let i = 0; i < WAVE_POINTS; i++) o.waveform[i] *= g;
    return o;
  }
}
