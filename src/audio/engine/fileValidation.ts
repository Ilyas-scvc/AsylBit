/** Client-side checks before a file is handed to the media element / decoder. */

export const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'wave', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4', 'webm', 'aif', 'aiff'] as const;

export const MAX_FILE_BYTES = 512 * 1024 * 1024;

const EXTENSION_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
};

export interface FileLike {
  name: string;
  type: string;
  size: number;
}

export type ValidationResult = { ok: true; mime: string; extension: string } | { ok: false; reason: string };

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Accepts anything that looks like audio by MIME type or extension. Final word on whether a
 * codec is playable belongs to the browser: the media element reports decode errors later.
 */
export function validateAudioFile(file: FileLike): ValidationResult {
  const extension = fileExtension(file.name);
  const knownExt = (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension);
  const type = file.type.toLowerCase();
  const audioMime = type.startsWith('audio/') || (type === 'video/mp4' && extension === 'm4a') || (type === 'video/webm' && extension === 'webm');
  if (!knownExt && !audioMime) {
    return { ok: false, reason: `NOT AN AUDIO FILE${extension ? ` (.${extension})` : ''} — USE MP3, WAV, FLAC, OGG OR M4A` };
  }
  if (file.size === 0) return { ok: false, reason: 'FILE IS EMPTY' };
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: 'FILE TOO LARGE — LIMIT IS 512 MB' };
  const mime = audioMime ? type : EXTENSION_MIME[extension] ?? 'audio/*';
  return { ok: true, mime, extension };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
