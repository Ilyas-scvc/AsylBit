/**
 * Export planning: pure functions shared by the Export Studio UI, the offline renderer and
 * the tests. No browser APIs here.
 */

export type Container = 'mp4' | 'mov' | 'webm';
export type VideoCodecId = 'avc' | 'hevc' | 'vp9' | 'vp8';
export type AudioCodecId = 'aac' | 'opus';
export type QualityLevel = 'low' | 'standard' | 'high' | 'veryhigh';
export type AspectId = '16:9' | '9:16' | '1:1';
export type ExportFps = 24 | 25 | 30 | 60;

export interface ContainerInfo {
  id: Container;
  label: string;
  extension: string;
  mime: string;
  video: VideoCodecId[];
  audio: AudioCodecId;
}

export const CONTAINERS: ContainerInfo[] = [
  { id: 'mp4', label: 'MP4', extension: 'mp4', mime: 'video/mp4', video: ['avc', 'hevc'], audio: 'aac' },
  { id: 'mov', label: 'MOV', extension: 'mov', mime: 'video/quicktime', video: ['avc', 'hevc'], audio: 'aac' },
  { id: 'webm', label: 'WEBM', extension: 'webm', mime: 'video/webm', video: ['vp9', 'vp8'], audio: 'opus' },
];

export const VIDEO_CODECS: Record<VideoCodecId, { label: string; efficiency: number }> = {
  avc: { label: 'H.264 / AVC', efficiency: 1 },
  hevc: { label: 'H.265 / HEVC', efficiency: 0.65 },
  vp9: { label: 'VP9', efficiency: 0.7 },
  vp8: { label: 'VP8', efficiency: 1.15 },
};

export const AUDIO_CODECS: Record<AudioCodecId, { label: string }> = {
  aac: { label: 'AAC-LC' },
  opus: { label: 'OPUS' },
};

export const FPS_OPTIONS: ExportFps[] = [24, 25, 30, 60];
export const DEFAULT_FPS: ExportFps = 30;
export const AUDIO_SAMPLE_RATE = 48000;

export interface Resolution {
  width: number;
  height: number;
  label: string;
  /** shown only after the encoder confirmed this size */
  requiresCheck?: boolean;
}

export const RESOLUTIONS: Record<AspectId, Resolution[]> = {
  '16:9': [
    { width: 1280, height: 720, label: '720P' },
    { width: 1920, height: 1080, label: '1080P' },
    { width: 3840, height: 2160, label: '4K', requiresCheck: true },
  ],
  '9:16': [
    { width: 720, height: 1280, label: '720 × 1280' },
    { width: 1080, height: 1920, label: '1080 × 1920' },
    { width: 2160, height: 3840, label: '2160 × 3840', requiresCheck: true },
  ],
  '1:1': [{ width: 1080, height: 1080, label: '1080 × 1080' }],
};

export const ASPECT_LABELS: Record<AspectId, string> = {
  '16:9': '16:9 · YOUTUBE',
  '9:16': '9:16 · SHORTS / REELS / TIKTOK',
  '1:1': '1:1 · SQUARE',
};

export const QUALITY_LEVELS: { id: QualityLevel; label: string; bpp: number }[] = [
  { id: 'low', label: 'LOW', bpp: 0.05 },
  { id: 'standard', label: 'STANDARD', bpp: 0.085 },
  { id: 'high', label: 'HIGH', bpp: 0.125 },
  { id: 'veryhigh', label: 'VERY HIGH', bpp: 0.18 },
];

export function containerInfo(id: Container): ContainerInfo {
  return CONTAINERS.find((c) => c.id === id)!;
}

/** Codecs that may go into a container — never e.g. VP8 in MP4 or H.264 in WebM here. */
export function codecsFor(container: Container): VideoCodecId[] {
  return containerInfo(container).video;
}

export function audioCodecFor(container: Container): AudioCodecId {
  return containerInfo(container).audio;
}

/**
 * Target video bitrate (bits/s) for variable-bitrate encoding. WebCodecs encoders take a
 * bitrate, not a CRF value, so quality levels are expressed as bits per pixel per frame.
 * Higher frame rates need fewer bits per frame, hence the sub-linear fps factor.
 */
export function videoBitrate(codec: VideoCodecId, width: number, height: number, fps: number, quality: QualityLevel): number {
  const bpp = QUALITY_LEVELS.find((q) => q.id === quality)?.bpp ?? 0.085;
  const fpsFactor = 30 * Math.pow(fps / 30, 0.75);
  const raw = bpp * width * height * fpsFactor * VIDEO_CODECS[codec].efficiency;
  return Math.round(Math.min(80e6, Math.max(1e6, raw)) / 1000) * 1000;
}

/** Preferred audio bitrates, best first; the capability check picks the first one that works. */
export function audioBitrates(codec: AudioCodecId, quality: QualityLevel): number[] {
  if (codec === 'opus') return quality === 'low' ? [128000] : quality === 'standard' ? [160000, 128000] : [192000, 160000];
  return quality === 'high' || quality === 'veryhigh' ? [256000, 192000, 160000] : [192000, 160000, 128000];
}

export function frameCount(start: number, end: number, fps: number): number {
  return Math.max(1, Math.round((end - start) * fps));
}

/** Music time shown in output frame n. */
export function frameTime(start: number, n: number, fps: number): number {
  return start + n / fps;
}

/**
 * Audio time the analysis of output frame n looks at: the middle of the frame's display
 * interval, so a sound event lands on the frame nearest to it instead of the next one
 * (frame n is on screen from n/fps to (n+1)/fps).
 */
export function analysisTime(frameT: number, fps: number): number {
  return frameT + 0.5 / fps;
}

/** Presentation timestamp of output frame n (the segment's local timeline starts at 0). */
export function frameTimestamp(n: number, fps: number): number {
  return n / fps;
}

export const PREROLL_SECONDS = 3;

/** Where the deterministic warm-up starts for a segment beginning at `start`. */
export function preRollStart(start: number, seconds = PREROLL_SECONDS): number {
  return Math.max(0, start - seconds);
}

/** Inclusive-exclusive sample range of a segment at a given sample rate. */
export function audioSampleRange(start: number, end: number, sampleRate: number): { first: number; count: number } {
  const first = Math.round(start * sampleRate);
  return { first, count: Math.max(0, Math.round(end * sampleRate) - first) };
}

/** Clamp a requested range to the track, keeping a minimum length. */
/** Shortest exported fragment (s); a track shorter than this is exported whole. */
export const MIN_EXPORT_SECONDS = 0.5;

/**
 * Keep a range inside [0, duration] and at least `minLength` long (or the whole track when it
 * is shorter than that). Rounded to milliseconds, never past the end of the track.
 */
export function clampRange(start: number, end: number, duration: number, minLength = MIN_EXPORT_SECONDS): { start: number; end: number } {
  const d = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const min = Math.min(minLength, d);
  const s0 = Number.isFinite(start) ? start : 0;
  const e0 = Number.isFinite(end) ? end : d;
  let s = Math.min(Math.max(0, s0), d - min);
  let e = Math.min(Math.max(e0, s + min), d);
  if (e - s < min) s = Math.max(0, e - min);
  s = Math.max(0, Math.round(s * 1000) / 1000);
  e = Math.min(d, Math.round(e * 1000) / 1000);
  return { start: s, end: e };
}

/**
 * The range an export may actually use for a track of `duration` seconds: clamped to the
 * track, or null when there is nothing to export. Guards against a stale selection (e.g. a
 * range chosen on a longer, since replaced track).
 */
export function exportRange(start: number, end: number, duration: number): { start: number; end: number } | null {
  if (!(duration > 0)) return null;
  const r = clampRange(start, end, duration);
  return r.end > r.start ? r : null;
}

/**
 * The selection to show after the loaded track changed: kept (clamped) for the same track,
 * reset to the first 30 s for a different one.
 */
export function rangeForTrack(previous: { start: number; end: number }, sameTrack: boolean, duration: number): { start: number; end: number } {
  if (!(duration > 0)) return { start: 0, end: 0 };
  return sameTrack && previous.end > previous.start ? clampRange(previous.start, previous.end, duration) : clampRange(0, Math.min(duration, 30), duration);
}

export function estimateBytes(videoBps: number, audioBps: number, seconds: number): number {
  return Math.round(((videoBps + audioBps) * seconds) / 8 * 1.02);
}

/** Rough peak memory for an in-memory export (encoded file + working buffers). */
export function estimateMemoryBytes(fileBytes: number, width: number, height: number): number {
  return fileBytes + width * height * 4 * 12 + 64 * 1024 * 1024;
}

/** Above this estimated size an in-memory export is refused (stream to disk instead). */
export const MAX_IN_MEMORY_BYTES = 1.5 * 1024 * 1024 * 1024;

export function exportFileName(trackName: string, container: Container, width: number, height: number, fps: number): string {
  const base = trackName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'track';
  return `beatform-${base}-${width}x${height}-${fps}fps.${containerInfo(container).extension}`;
}

export interface ExportSpec {
  container: Container;
  videoCodec: VideoCodecId;
  audioCodec: AudioCodecId;
  width: number;
  height: number;
  fps: ExportFps;
  quality: QualityLevel;
  videoBitrate: number;
  audioBitrate: number;
  start: number;
  end: number;
}
