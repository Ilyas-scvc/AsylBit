/**
 * Waveform timeline with seek. The waveform, band-energy strip and kick markers come from
 * the pre-analysis; the playhead follows the real media clock. Accessible as a slider.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { engine, seek } from '../audio/controller';
import { EventType } from '../audio/dsp/events';
import type { OfflineAnalysisResult } from '../audio/dsp/offlineAnalysis';
import { usePlayer } from '../state/player';
import { useSettings } from '../state/settings';
import { formatTime } from './format';

function drawWaveform(canvas: HTMLCanvasElement, data: OfflineAnalysisResult | null, color: string, markers: string, withBands: boolean) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const waveH = h * 0.72;
  const mid = waveH / 2;
  if (!data) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(0, Math.round(mid), w, Math.max(1, dpr));
    return;
  }
  const { waveform, buckets, bandMap, events, duration } = data;
  let peakMax = 0;
  for (let b = 0; b < buckets; b++) peakMax = Math.max(peakMax, waveform[b * 2]);
  const norm = peakMax > 0 ? 1 / peakMax : 1;
  const barW = Math.max(1, Math.floor(dpr));
  const step = barW + (dpr >= 2 ? 1 : 0);
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
    const ph = Math.max(dpr, pk * norm * mid * 0.95);
    const rh = Math.max(dpr, rms * norm * mid * 1.3);
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, mid - ph, barW, ph * 2);
    ctx.globalAlpha = 0.95;
    ctx.fillRect(x, mid - rh, barW, rh * 2);
  }
  if (withBands) {
    // three thin rows: bass / mid / high energy over time
    const rowH = (h - waveH - 2 * dpr) / 3;
    for (let band = 0; band < 3; band++) {
      const y = waveH + 2 * dpr + band * rowH;
      for (let x = 0; x < w; x += step) {
        const b = Math.min(buckets - 1, Math.floor((x / w) * buckets));
        ctx.globalAlpha = 0.08 + 0.8 * bandMap[b * 3 + band] ** 2;
        ctx.fillRect(x, y, step, Math.max(1, rowH - dpr));
      }
    }
  }
  // kick markers along the top edge
  ctx.fillStyle = markers;
  ctx.globalAlpha = 0.7;
  for (let i = 0; i < events.times.length; i++) {
    if (events.types[i] !== EventType.KICK) continue;
    const x = Math.round((events.times[i] / duration) * w);
    ctx.fillRect(x, 0, Math.max(1, Math.floor(dpr)), 3 * dpr);
  }
  ctx.globalAlpha = 1;
}

export function Timeline() {
  const analysis = usePlayer((s) => s.analysis);
  const duration = usePlayer((s) => s.duration);
  const status = usePlayer((s) => s.status);
  const analysisStatus = usePlayer((s) => s.analysisStatus);
  const progress = usePlayer((s) => s.analysisProgress);
  const lastSeek = usePlayer((s) => s.lastSeek);
  const accent = useSettings((s) => s.accent);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const playedRef = useRef<HTMLCanvasElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  const redraw = useCallback(() => {
    if (baseRef.current) drawWaveform(baseRef.current, analysis, 'rgba(236,236,230,0.55)', 'rgba(236,236,230,0.6)', true);
    if (playedRef.current) drawWaveform(playedRef.current, analysis, accent, accent, true);
  }, [analysis, accent]);

  useEffect(() => {
    redraw();
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [redraw]);

  // playhead follows the media clock
  useEffect(() => {
    if (status !== 'ready') return;
    let raf = 0;
    let last = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const d = engine.duration || duration;
      const t = dragging.current ?? engine.currentTime;
      const p = d > 0 ? Math.min(1, Math.max(0, t / d)) : 0;
      if (Math.abs(p - last) < 1e-5) return;
      last = p;
      const pct = p * 100;
      if (clipRef.current) clipRef.current.style.clipPath = `inset(0 ${(100 - pct).toFixed(3)}% 0 0)`;
      if (headRef.current) headRef.current.style.left = `${pct.toFixed(3)}%`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status, duration]);

  const timeAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return { x: p * r.width, t: p * (engine.duration || duration) };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (status !== 'ready' || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = timeAt(e.clientX).t;
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (status !== 'ready') return;
    const at = timeAt(e.clientX);
    if (dragging.current !== null) dragging.current = at.t;
    if (e.pointerType === 'mouse') setHover(at);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current === null) return;
    const t = timeAt(e.clientX).t;
    dragging.current = null;
    seek(t);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = engine.duration;
    if (!d) return;
    const now = engine.currentTime;
    const map: Record<string, number> = {
      ArrowLeft: now - 5,
      ArrowRight: now + 5,
      ArrowDown: now - 5,
      ArrowUp: now + 5,
      PageDown: now - 30,
      PageUp: now + 30,
      Home: 0,
      End: d - 0.5,
    };
    if (e.key in map) {
      e.preventDefault();
      e.stopPropagation();
      seek(map[e.key]);
    }
  };

  const d = duration;
  const label = analysisStatus === 'decoding' ? 'DECODING' : analysisStatus === 'analyzing' ? `ANALYZING ${Math.round(progress * 100)}%` : null;

  return (
    <div
      className="timeline"
      ref={trackRef}
      role="slider"
      tabIndex={status === 'ready' ? 0 : -1}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(d)}
      aria-valuenow={Math.round(lastSeek)}
      aria-valuetext={`${formatTime(lastSeek)} of ${formatTime(d)}`}
      aria-disabled={status !== 'ready'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (dragging.current = null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
    >
      <canvas ref={baseRef} className="timeline-canvas" />
      <div ref={clipRef} className="timeline-played" style={{ clipPath: 'inset(0 100% 0 0)' }}>
        <canvas ref={playedRef} className="timeline-canvas" />
      </div>
      <div ref={headRef} className="timeline-head" />
      {label && (
        <div className="timeline-progress" style={{ ['--p' as string]: progress }}>
          <span>{label}</span>
        </div>
      )}
      {hover && (
        <div className="timeline-hover" style={{ left: hover.x }}>
          {formatTime(hover.t)}
        </div>
      )}
    </div>
  );
}
