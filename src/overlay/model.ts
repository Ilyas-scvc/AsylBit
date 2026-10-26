/**
 * The stage captions — HUD, track title and compact player — as data and text. One source for
 * the live page, HIDE UI, the export preview and every exported frame: the DOM components and
 * the canvas painter format their text with these functions, so they always read the same.
 */
import { binWidth } from '../audio/dsp/bands';
import { formatBytes } from '../audio/engine/fileValidation';
import { formatKhz, formatTime, stripExtension } from '../ui/format';

export const HUD_METERS = [
  { key: 'bass', label: 'BASS', range: '20–150 HZ' },
  { key: 'mid', label: 'MID', range: '150–2K' },
  { key: 'high', label: 'HIGH', range: '2K–12K' },
] as const;

export const HUD_LIGHTS = [
  { key: 'kick', label: 'KICK' },
  { key: 'snare', label: 'SNARE' },
  { key: 'hat', label: 'HAT' },
  { key: 'tone', label: 'TONE' },
] as const;

/** What is known about the loaded track (constant for a whole export). */
export interface OverlayTrack {
  name: string;
  /** file extension, e.g. "wav" */
  extension: string;
  /** file size in bytes */
  size: number;
  /** seconds */
  duration: number;
  /** events of the pre-computed map, or null when only real-time detection runs */
  mapped: { events: number; bpm: number | null; counts: readonly [number, number, number, number] } | null;
}

/** The values one frame shows. */
export interface OverlayFrame {
  sceneIndex: string;
  sceneName: string;
  /** degrees, from the scene instance that drew this frame */
  rotation: number;
  tilt: number;
  /** frames per second (measured live; the chosen rate in an export) or null if unknown */
  fps: number | null;
  /** bass, mid, high levels */
  levels: readonly [number, number, number];
  /** kick, snare, hat, tone envelopes */
  lights: readonly [number, number, number, number];
  /** analyser actually in use */
  fftSize: number;
  sampleRate: number;
  /** position in the source track, seconds */
  time: number;
  playing: boolean;
}

export function figLabel(index: string, name: string): string {
  return `FIG. ${index} — ${name}`;
}

export function readoutLabel(rotation: number, tilt: number, fps: number | null): string {
  return `[ROT ${rotation.toFixed(1).padStart(5, '0')}°] [TILT ${tilt.toFixed(1)}°] [FPS ${fps || '—'}]`;
}

/** Meter bar fill 0..1. */
export function meterFill(level: number): number {
  return Math.min(1, Math.max(0, level));
}

export function meterText(level: number): string {
  return Math.min(9.99, Math.max(0, level)).toFixed(2);
}

/** Event light intensity 0..1. */
export function lightOn(envelope: number): number {
  return Math.min(1, Math.max(0, envelope * 1.6));
}

export function fftLabel(fftSize: number, sampleRate: number): string {
  const bin = sampleRate ? binWidth(sampleRate, fftSize).toFixed(1) : '—';
  return `FFT ${fftSize} · ${formatKhz(sampleRate)} · ${bin} HZ/BIN`;
}

export type EventsState = { kind: 'none' } | { kind: 'mapped'; events: number; bpm: number | null } | { kind: 'realtime'; note?: string | null } | { kind: 'pending' };

export function eventsLabel(state: EventsState): string {
  switch (state.kind) {
    case 'mapped':
      return `EVENTS: MAPPED · ${state.events}${state.bpm ? ` · ≈${state.bpm} BPM` : ''}`;
    case 'realtime':
      return `EVENTS: REAL-TIME${state.note ? ` · ${state.note}` : ''}`;
    case 'pending':
      return 'EVENTS: REAL-TIME (MAP PENDING)';
    default:
      return 'EVENTS: —';
  }
}

export function nowLabel(extension: string, duration: number): string {
  return `[NOW] ${extension.toUpperCase()} · ${formatTime(duration)} · LOCAL FILE`;
}

/**
 * The big outlined title: underscores as spaces, at most 40 characters, and a size factor that
 * shrinks long names (applied to the font size, never below 0.42).
 */
export function trackTitle(fileName: string): { text: string; k: number } {
  const name = stripExtension(fileName).replace(/[_]+/g, ' ');
  const text = name.length > 40 ? `${name.slice(0, 39)}…` : name;
  return { text, k: Math.max(0.42, Math.min(1, 15 / Math.max(1, text.length))) };
}

export function playerTitle(fileName: string): string {
  return stripExtension(fileName);
}

/** "WAV · 4.7 MB · 48.0 KHZ · MAPPED 32K/16S/64H" — `status` replaces the last part while analysing. */
export function playerSubLabel(extension: string, size: number, sampleRate: number, status: string | null): string {
  const parts = [extension.toUpperCase() || 'AUDIO', formatBytes(size)];
  if (sampleRate) parts.push(formatKhz(sampleRate));
  if (status) parts.push(status);
  return parts.join(' · ');
}

export function mappedStatus(counts: readonly [number, number, number, number]): string {
  return `MAPPED ${counts[0]}K/${counts[1]}S/${counts[2]}H`;
}

export function timeLabels(time: number, duration: number): { now: string; total: string } {
  return { now: formatTime(time, true), total: ` / ${formatTime(duration, true)}` };
}

/** Playhead position on the whole track, 0..1. */
export function trackProgress(time: number, duration: number): number {
  return duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
}
