/**
 * Player / track state for the UI. Updated from engine events and the pre-analysis
 * pipeline — never once per frame (the render loop reads the AudioFrame instead).
 */
import { create } from 'zustand';
import type { OfflineAnalysisResult } from '../audio/dsp/offlineAnalysis';

export type LoadStatus = 'empty' | 'loading' | 'ready' | 'error';
export type AnalysisStatus = 'idle' | 'decoding' | 'analyzing' | 'ready' | 'unavailable';

export interface TrackInfo {
  name: string;
  size: number;
  type: string;
  extension: string;
  duration: number;
}

export interface PlayerState {
  status: LoadStatus;
  error: string | null;
  track: TrackInfo | null;
  playing: boolean;
  buffering: boolean;
  loop: boolean;
  volume: number;
  muted: boolean;
  duration: number;
  /** seconds, updated on seek / pause / ended only (live time is drawn from the media clock) */
  lastSeek: number;
  analysisStatus: AnalysisStatus;
  analysisProgress: number;
  analysisMessage: string | null;
  analysis: OfflineAnalysisResult | null;
  contextState: AudioContextState | 'none';
  sampleRate: number;
}

export const usePlayer = create<PlayerState>()(() => ({
  status: 'empty',
  error: null,
  track: null,
  playing: false,
  buffering: false,
  loop: false,
  volume: 0.85,
  muted: false,
  duration: 0,
  lastSeek: 0,
  analysisStatus: 'idle',
  analysisProgress: 0,
  analysisMessage: null,
  analysis: null,
  contextState: 'none',
  sampleRate: 0,
}));

const PREFS_KEY = 'beatform.player.v1';

export function loadPlayerPrefs(): { volume: number; loop: boolean } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    const volume = typeof raw.volume === 'number' && Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : 0.85;
    return { volume, loop: raw.loop === true };
  } catch {
    return { volume: 0.85, loop: false };
  }
}

export function savePlayerPrefs(volume: number, loop: boolean): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ volume, loop }));
  } catch {
    /* ignore */
  }
}
