/**
 * Audio modulation: bind any numeric parameter to an audio source.
 *
 *   value = base + amount · envelope(shape(source)) · (max − min of the parameter)
 *
 * shape = threshold gate → input window (min..max) → curve → invert, and the envelope is
 * a frame-rate independent attack/release follower. Every step is bounded and smooth, so a
 * modulated parameter can never jump by more than its attack time allows.
 */
import { attackRelease, clamp } from '../audio/dsp/envelope';
import type { ParamDef, ParamValues, SceneAudio } from './types';

export type ModSource = 'off' | 'bass' | 'mids' | 'treble' | 'full' | 'kick' | 'snare' | 'rms' | 'lfo';
export type ModCurve = 'linear' | 'exp' | 'log' | 'smooth';

export const MOD_SOURCES: { id: ModSource; label: string }[] = [
  { id: 'off', label: 'OFF' },
  { id: 'bass', label: 'BASS' },
  { id: 'mids', label: 'MIDS' },
  { id: 'treble', label: 'TREBLE' },
  { id: 'full', label: 'FULL SPECTRUM' },
  { id: 'kick', label: 'KICK ONSET' },
  { id: 'snare', label: 'SNARE ONSET' },
  { id: 'rms', label: 'RMS' },
  { id: 'lfo', label: 'LFO (TIME)' },
];

export const MOD_CURVES: { id: ModCurve; label: string }[] = [
  { id: 'linear', label: 'LINEAR' },
  { id: 'exp', label: 'EXP' },
  { id: 'log', label: 'LOG' },
  { id: 'smooth', label: 'S-CURVE' },
];

export interface ModulationBinding {
  id: string;
  /** parameter key, or `fx:<effectId>:<param>` for post-processing parameters */
  target: string;
  source: ModSource;
  /** −1..1, fraction of the parameter range */
  amount: number;
  /** seconds */
  attack: number;
  /** seconds */
  release: number;
  /** input window on the source, 0..1 */
  min: number;
  max: number;
  invert: boolean;
  curve: ModCurve;
  /** source values below this are treated as 0 */
  threshold: number;
  /** LFO frequency (Hz) */
  lfoRate: number;
}

export const MIN_ENVELOPE_TIME = 0.005;

export function createBinding(target: string, source: ModSource = 'bass', id?: string): ModulationBinding {
  return {
    id: id ?? `m-${target}`,
    target,
    source,
    amount: 0.25,
    attack: 0.02,
    release: 0.25,
    min: 0,
    max: 1,
    invert: false,
    curve: 'linear',
    threshold: 0,
    lfoRate: 0.25,
  };
}

const SOURCES = new Set(MOD_SOURCES.map((s) => s.id));
const CURVES = new Set(MOD_CURVES.map((c) => c.id));

export function sanitizeBinding(raw: unknown): ModulationBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.target !== 'string' || r.target.length === 0 || r.target.length > 80) return null;
  const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : def);
  const base = createBinding(r.target);
  let min = num(r.min, 0, 1, 0);
  let max = num(r.max, 0, 1, 1);
  if (max - min < 0.01) {
    min = 0;
    max = 1;
  }
  return {
    id: typeof r.id === 'string' && r.id.length <= 80 ? r.id : base.id,
    target: r.target,
    source: typeof r.source === 'string' && SOURCES.has(r.source as ModSource) ? (r.source as ModSource) : 'off',
    amount: num(r.amount, -1, 1, base.amount),
    attack: num(r.attack, MIN_ENVELOPE_TIME, 5, base.attack),
    release: num(r.release, MIN_ENVELOPE_TIME, 10, base.release),
    min,
    max,
    invert: r.invert === true,
    curve: typeof r.curve === 'string' && CURVES.has(r.curve as ModCurve) ? (r.curve as ModCurve) : 'linear',
    threshold: num(r.threshold, 0, 0.99, 0),
    lfoRate: num(r.lfoRate, 0.01, 8, base.lfoRate),
  };
}

/** Raw source value in 0..1 for a frame. `time` drives the LFO deterministically. */
export function sourceValue(source: ModSource, a: SceneAudio, time: number, lfoRate: number): number {
  switch (source) {
    case 'bass':
      return Math.min(1, a.bass);
    case 'mids':
      return Math.min(1, a.mids);
    case 'treble':
      return Math.min(1, a.treble);
    case 'full': {
      let s = 0;
      for (let i = 0; i < a.spectrum.length; i++) s += a.spectrum[i];
      return Math.min(1, (s / a.spectrum.length) * 1.6);
    }
    case 'kick':
      return Math.min(1, a.kick);
    case 'snare':
      return Math.min(1, a.snare);
    case 'rms':
      return Math.min(1, a.rms);
    case 'lfo':
      return 0.5 + 0.5 * Math.sin(2 * Math.PI * lfoRate * time);
    default:
      return 0;
  }
}

/** Threshold gate → input window → curve → invert. Pure, output in 0..1. */
export function shapeValue(raw: number, b: Pick<ModulationBinding, 'threshold' | 'min' | 'max' | 'curve' | 'invert'>): number {
  let v = clamp(raw, 0, 1);
  if (b.threshold > 0) v = v <= b.threshold ? 0 : (v - b.threshold) / (1 - b.threshold);
  const span = Math.max(0.01, b.max - b.min);
  v = clamp((v - b.min) / span, 0, 1);
  switch (b.curve) {
    case 'exp':
      v = v * v;
      break;
    case 'log':
      v = Math.sqrt(v);
      break;
    case 'smooth':
      v = v * v * (3 - 2 * v);
      break;
  }
  return b.invert ? 1 - v : v;
}

export class ModulationEngine {
  private readonly env = new Map<string, number>();

  reset(): void {
    this.env.clear();
  }

  /** Current envelope value of a binding (0..1), for the Inspector's activity meter. */
  level(id: string): number {
    return this.env.get(id) ?? 0;
  }

  /**
   * Resolve modulated values. `base` is not mutated; results are written to `out`
   * (which should already contain the base values).
   */
  apply(
    bindings: readonly ModulationBinding[],
    defs: Map<string, ParamDef>,
    base: ParamValues,
    audio: SceneAudio,
    time: number,
    dt: number,
    out: ParamValues,
  ): void {
    for (const b of bindings) {
      const def = defs.get(b.target);
      if (!def || def.type !== 'number' || def.modulatable === false) continue;
      const baseValue = base[b.target];
      if (typeof baseValue !== 'number') continue;
      let e = this.env.get(b.id) ?? 0;
      const target = b.source === 'off' ? 0 : shapeValue(sourceValue(b.source, audio, time, b.lfoRate), b);
      e = attackRelease(e, target, dt, Math.max(MIN_ENVELOPE_TIME, b.attack), Math.max(MIN_ENVELOPE_TIME, b.release));
      this.env.set(b.id, e);
      const range = (def.max ?? 1) - (def.min ?? 0);
      out[b.target] = clamp(baseValue + b.amount * e * range, def.min ?? -Infinity, def.max ?? Infinity);
    }
  }
}
