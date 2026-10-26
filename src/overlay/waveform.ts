/**
 * Whole-track waveform of the player (peaks + RMS, three band-energy rows and kick markers),
 * drawn the same way into the live timeline canvas and into the cached layers of exported
 * frames.
 */
import { EventType, type EventMap } from '../audio/dsp/events';

export interface WaveformData {
  duration: number;
  buckets: number;
  /** interleaved [peak, rms] per bucket */
  waveform: Float32Array;
  /** interleaved [bass, mid, high] per bucket, 0..1 */
  bandMap: Float32Array;
  events: EventMap;
}

/** Draw into a w × h pixel area; `px` is the device-pixel unit (1 at 1×, 2 on a 2× screen …). */
export function drawWaveform(ctx: CanvasRenderingContext2D, w: number, h: number, px: number, data: WaveformData | null, color: string, markers: string, withBands: boolean): void {
  ctx.clearRect(0, 0, w, h);
  const waveH = h * 0.72;
  const mid = waveH / 2;
  if (!data) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(0, Math.round(mid), w, Math.max(1, px));
    ctx.globalAlpha = 1;
    return;
  }
  const { waveform, buckets, bandMap, events, duration } = data;
  let peakMax = 0;
  for (let b = 0; b < buckets; b++) peakMax = Math.max(peakMax, waveform[b * 2]);
  const norm = peakMax > 0 ? 1 / peakMax : 1;
  const barW = Math.max(1, Math.floor(px));
  const step = barW + (px >= 2 ? 1 : 0);
  ctx.fillStyle = color;
  for (let x = 0; x < w; x += step) {
    const b0 = Math.floor((x / w) * buckets);
    const b1 = Math.max(b0 + 1, Math.floor(((x + step) / w) * buckets));
    let pk = 0;
    let rms = 0;
    for (let b = b0; b < b1 && b < buckets; b++) {
      pk = Math.max(pk, waveform[b * 2]);
      rms = Math.max(rms, waveform[b * 2 + 1]);
    }
    const ph = Math.max(px, pk * norm * mid * 0.95);
    const rh = Math.max(px, rms * norm * mid * 1.3);
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, mid - ph, barW, ph * 2);
    ctx.globalAlpha = 0.95;
    ctx.fillRect(x, mid - rh, barW, rh * 2);
  }
  if (withBands) {
    // three thin rows: bass / mid / high energy over time
    const rowH = (h - waveH - 2 * px) / 3;
    for (let band = 0; band < 3; band++) {
      const y = waveH + 2 * px + band * rowH;
      for (let x = 0; x < w; x += step) {
        const b = Math.min(buckets - 1, Math.floor((x / w) * buckets));
        ctx.globalAlpha = 0.08 + 0.8 * bandMap[b * 3 + band] ** 2;
        ctx.fillRect(x, y, step, Math.max(1, rowH - px));
      }
    }
  }
  // kick markers along the top edge
  ctx.fillStyle = markers;
  ctx.globalAlpha = 0.7;
  for (let i = 0; i < events.times.length; i++) {
    if (events.types[i] !== EventType.KICK) continue;
    const x = Math.round((events.times[i] / duration) * w);
    ctx.fillRect(x, 0, Math.max(1, Math.floor(px)), 3 * px);
  }
  ctx.globalAlpha = 1;
}

/** The base colour of the unplayed waveform (the played part uses the accent). */
export const WAVE_BASE = 'rgba(236,236,230,0.55)';
export const WAVE_MARKERS = 'rgba(236,236,230,0.6)';
