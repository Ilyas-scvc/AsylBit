/**
 * Visualizer settings: defaults, safe ranges, sanitising and local persistence.
 * Settings live in localStorage only — nothing is sent anywhere.
 */
import { create } from 'zustand';
import { isPerformancePreset, presetFromLegacyQuality } from '../engine/quality';
import type { PerformancePreset } from '../engine/types';

export type VisualMode = 'pulse' | 'radial' | 'wave';
export type ReducedMotionSetting = 'auto' | 'on' | 'off';
export type QualitySetting = 'auto' | 'high' | 'low';

export interface VisualSettings {
  mode: VisualMode;
  accent: string;
  background: string;
  bassSensitivity: number;
  midSensitivity: number;
  highSensitivity: number;
  beatImpact: number;
  smoothing: number;
  particleDensity: number;
  rotationSpeed: number;
  intensity: number;
  reducedMotion: ReducedMotionSetting;
  fftSize: 2048 | 4096;
  quality: QualitySetting;
  /** live-stage performance preset (BEAT//FORM 2.0) */
  performance: PerformancePreset;
}

export type NumericSettingKey =
  | 'bassSensitivity'
  | 'midSensitivity'
  | 'highSensitivity'
  | 'beatImpact'
  | 'smoothing'
  | 'particleDensity'
  | 'rotationSpeed'
  | 'intensity';

export interface Range {
  min: number;
  max: number;
  step: number;
}

export const RANGES: Record<NumericSettingKey, Range> = {
  bassSensitivity: { min: 0, max: 2.5, step: 0.05 },
  midSensitivity: { min: 0, max: 2.5, step: 0.05 },
  highSensitivity: { min: 0, max: 2.5, step: 0.05 },
  beatImpact: { min: 0, max: 2, step: 0.05 },
  smoothing: { min: 0, max: 1, step: 0.01 },
  particleDensity: { min: 0.1, max: 1, step: 0.05 },
  rotationSpeed: { min: 0, max: 2, step: 0.05 },
  intensity: { min: 0.2, max: 1.5, step: 0.05 },
};

export const MODES: { id: VisualMode; index: string; name: string; short: string }[] = [
  { id: 'pulse', index: '01', name: 'PULSE OBJECT', short: 'PULSE' },
  { id: 'radial', index: '02', name: 'RADIAL SPECTRUM', short: 'RADIAL' },
  { id: 'wave', index: '03', name: 'WAVE FIELD', short: 'FIELD' },
];

export const ACCENT_PRESETS = ['#d4ff3a', '#ff5b2e', '#3ad8ff', '#ff3ac8', '#f2f2f2'];
export const BACKGROUND_PRESETS = ['#050505', '#0b0c10', '#101010', '#0d0a12', '#07100c'];

export const DEFAULT_SETTINGS: VisualSettings = {
  mode: 'pulse',
  accent: '#d4ff3a',
  background: '#050505',
  bassSensitivity: 1,
  midSensitivity: 1,
  highSensitivity: 1,
  beatImpact: 1,
  smoothing: 0.45,
  particleDensity: 0.6,
  rotationSpeed: 1,
  intensity: 1,
  reducedMotion: 'auto',
  fftSize: 2048,
  quality: 'auto',
  performance: 'balanced',
};

const STORAGE_KEY = 'beatform.settings.v1';
const HEX = /^#[0-9a-f]{6}$/i;

export function clampToRange(key: NumericSettingKey, value: unknown): number {
  const r = RANGES[key];
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS[key];
  return Math.min(r.max, Math.max(r.min, n));
}

/** Turn anything (e.g. a tampered localStorage entry) into valid settings. */
export function sanitizeSettings(raw: unknown): VisualSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: VisualSettings = { ...DEFAULT_SETTINGS };
  if (src.mode === 'pulse' || src.mode === 'radial' || src.mode === 'wave') out.mode = src.mode;
  if (typeof src.accent === 'string' && HEX.test(src.accent)) out.accent = src.accent.toLowerCase();
  if (typeof src.background === 'string' && HEX.test(src.background)) out.background = darkEnough(src.background.toLowerCase());
  for (const key of Object.keys(RANGES) as NumericSettingKey[]) {
    if (key in src) out[key] = clampToRange(key, src[key]);
  }
  if (src.reducedMotion === 'auto' || src.reducedMotion === 'on' || src.reducedMotion === 'off') out.reducedMotion = src.reducedMotion;
  if (src.fftSize === 2048 || src.fftSize === 4096) out.fftSize = src.fftSize;
  if (src.quality === 'auto' || src.quality === 'high' || src.quality === 'low') out.quality = src.quality;
  out.performance = isPerformancePreset(src.performance) ? src.performance : presetFromLegacyQuality(src.quality);
  return out;
}

/** The UI is white-on-dark; keep custom backgrounds dark enough for legible text. */
export function darkEnough(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum <= 0.22) return hex;
  const k = 0.22 / lum;
  const to = (v: number) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function load(): VisualSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

interface SettingsStore extends VisualSettings {
  set: <K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>()((set) => ({
  ...(typeof window !== 'undefined' ? load() : DEFAULT_SETTINGS),
  set: (key, value) =>
    set((state) => {
      const next = sanitizeSettings({ ...pick(state), [key]: value });
      return next;
    }),
  reset: () => set({ ...DEFAULT_SETTINGS }),
}));

export function pick(state: VisualSettings): VisualSettings {
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = state[key as keyof VisualSettings];
  return out as unknown as VisualSettings;
}

let saveTimer: number | undefined;
if (typeof window !== 'undefined') {
  useSettings.subscribe((state) => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pick(state)));
      } catch {
        /* storage unavailable (private mode, quota): settings stay in memory */
      }
    }, 250);
  });
}

/** Resolve the effective reduced-motion flag from the setting and the OS preference. */
export function resolveReducedMotion(setting: ReducedMotionSetting, systemPrefers: boolean): boolean {
  return setting === 'on' || (setting === 'auto' && systemPrefers);
}
