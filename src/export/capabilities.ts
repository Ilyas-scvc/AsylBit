/**
 * Real encoder capability checks for the Export Studio.
 *
 * `canEncodeVideo` / `canEncodeAudio` ask WebCodecs `isConfigSupported` with the actual
 * size, frame rate and bitrate. Because `isConfigSupported` can be optimistic (notably for
 * HEVC and very large frames), HEVC and 4K are additionally probe-encoded: a few real
 * frames go through a throw-away Mediabunny output, and the option is only offered if
 * that succeeds. AAC falls back to the WASM encoder extension when the browser has none.
 */
import type { AudioCodecId, Container, VideoCodecId } from './plan';

type Mediabunny = typeof import('mediabunny');

let mbPromise: Promise<Mediabunny> | null = null;
export function loadMediabunny(): Promise<Mediabunny> {
  mbPromise ??= import('mediabunny');
  return mbPromise;
}

export function hasWebCodecs(): boolean {
  return typeof window !== 'undefined' && typeof window.VideoEncoder === 'function' && typeof window.AudioEncoder === 'function' && typeof window.VideoFrame === 'function';
}

export function canStreamToDisk(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

export interface Support {
  ok: boolean;
  reason?: string;
}

const videoCache = new Map<string, Promise<Support>>();
const audioCache = new Map<string, Promise<Support>>();
let aacPolyfill: Promise<boolean> | null = null;
let aacPolyfillOn = false;

/**
 * Encoder delay of the WASM AAC encoder (FFmpeg's AAC encoder: 1024 samples of initial
 * padding). Its packets are stamped from the first input sample, so the export starts the
 * audio this much earlier and the MP4/MOV edit list trims the padding again — exactly what
 * happens with the browser's own encoder. Measured: without it the audio lands 1024 samples late.
 */
export const AAC_POLYFILL_PRIMING_FRAMES = 1024;

/** Encode a few frames for real; catches encoders that claim support but fail. */
async function probeEncode(mb: Mediabunny, codec: VideoCodecId, width: number, height: number, fps: number, bitrate: number): Promise<Support> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, reason: 'NO 2D CONTEXT FOR PROBE' };
  const format = codec === 'vp8' || codec === 'vp9' ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat();
  const output = new mb.Output({ format, target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(canvas, { codec, quality: new mb.Quality({ bitrate }), hardwareAcceleration: codec === 'hevc' ? 'prefer-hardware' : 'no-preference' });
  output.addVideoTrack(source, { frameRate: fps });
  try {
    await output.start();
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = `rgb(${i * 80},${255 - i * 60},120)`;
      ctx.fillRect(0, 0, width, height);
      await source.add(i / fps, 1 / fps);
    }
    source.close();
    await output.finalize();
    const size = output.target.buffer?.byteLength ?? 0;
    return size > 0 ? { ok: true } : { ok: false, reason: 'ENCODER PRODUCED NO DATA' };
  } catch (err) {
    try {
      await output.cancel();
    } catch {
      /* already closed */
    }
    return { ok: false, reason: `PROBE ENCODE FAILED: ${err instanceof Error ? err.message.slice(0, 80).toUpperCase() : 'UNKNOWN'}` };
  }
}

export function checkVideo(codec: VideoCodecId, width: number, height: number, fps: number, bitrate: number): Promise<Support> {
  const key = `${codec}|${width}x${height}|${fps}|${Math.round(bitrate / 1e5)}`;
  let p = videoCache.get(key);
  if (!p) {
    p = (async () => {
      if (!hasWebCodecs()) return { ok: false, reason: 'WEBCODECS NOT AVAILABLE IN THIS BROWSER' };
      const mb = await loadMediabunny();
      const ok = await mb.canEncodeVideo(codec, { width, height, frameRate: fps, quality: new mb.Quality({ bitrate }) });
      if (!ok) return { ok: false, reason: `${codec.toUpperCase()} ${width}×${height} @ ${fps} FPS NOT SUPPORTED BY THIS DEVICE` };
      const big = width * height > 1920 * 1088;
      if (codec === 'hevc' || big) return probeEncode(mb, codec, width, height, fps, bitrate);
      return { ok: true };
    })().catch((err) => ({ ok: false, reason: String(err?.message ?? err).toUpperCase() }));
    videoCache.set(key, p);
  }
  return p;
}

/**
 * Register the WASM AAC encoder (≈1 MB, loaded on demand). Registration is permanent and
 * Mediabunny then prefers it for every AAC encode, so it is only used when the browser has
 * no native AAC encoder at any offered bitrate.
 */
export function ensureAacPolyfill(): Promise<boolean> {
  aacPolyfill ??= import('@mediabunny/aac-encoder')
    .then((m) => {
      m.registerAacEncoder();
      aacPolyfillOn = true;
      return true;
    })
    .catch(() => false);
  return aacPolyfill;
}

/** True once AAC goes through the WASM encoder (see AAC_POLYFILL_PRIMING_FRAMES). */
export function aacPolyfillActive(): boolean {
  return aacPolyfillOn;
}

/** Native (browser) encoder support for 48 kHz stereo at `bitrate`. */
export function checkAudio(codec: AudioCodecId, bitrate: number): Promise<Support> {
  const key = `${codec}|${bitrate}`;
  let p = audioCache.get(key);
  if (!p) {
    p = (async () => {
      if (!hasWebCodecs()) return { ok: false, reason: 'WEBCODECS NOT AVAILABLE IN THIS BROWSER' };
      const mb = await loadMediabunny();
      const opts = { numberOfChannels: 2, sampleRate: 48000, quality: new mb.Quality({ bitrate }) };
      if (await mb.canEncodeAudio(codec, opts)) return { ok: true };
      return { ok: false, reason: `${codec.toUpperCase()} ${Math.round(bitrate / 1000)} KBPS NOT SUPPORTED` };
    })().catch((err) => ({ ok: false, reason: String(err?.message ?? err).toUpperCase() }));
    audioCache.set(key, p);
  }
  return p;
}

/**
 * First audio bitrate in `candidates` that the device can encode — natively if at all
 * possible, otherwise (AAC only) with the WASM encoder.
 */
export async function pickAudioBitrate(codec: AudioCodecId, candidates: number[]): Promise<{ bitrate: number; polyfill?: boolean } | null> {
  if (codec === 'aac' && aacPolyfillActive()) return candidates.length ? { bitrate: candidates[0], polyfill: true } : null;
  for (const b of candidates) {
    if ((await checkAudio(codec, b)).ok) return { bitrate: b };
  }
  if (codec !== 'aac' || !hasWebCodecs() || !(await ensureAacPolyfill())) return null;
  const mb = await loadMediabunny();
  for (const b of candidates) {
    if (await mb.canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48000, quality: new mb.Quality({ bitrate: b }) })) return { bitrate: b, polyfill: true };
  }
  return null;
}

export function containerSupported(container: Container): Support {
  void container;
  return hasWebCodecs() ? { ok: true } : { ok: false, reason: 'WEBCODECS NOT AVAILABLE' };
}
