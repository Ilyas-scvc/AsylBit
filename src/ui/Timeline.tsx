/**
 * Waveform timeline with seek. The waveform, band-energy strip and kick markers come from
 * the pre-analysis; the playhead follows the real media clock. Accessible as a slider.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { engine, seek } from '../audio/controller';
import type { OfflineAnalysisResult } from '../audio/dsp/offlineAnalysis';
import { usePlayer } from '../state/player';
import { useVisual } from '../state/visual';
import { drawWaveform, WAVE_BASE, WAVE_MARKERS } from '../overlay/waveform';
import { formatTime } from './format';

/** Size the canvas to its box at the device pixel ratio, then draw the shared waveform into it. */
function paintWaveform(canvas: HTMLCanvasElement, data: OfflineAnalysisResult | null, color: string, markers: string) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (ctx) drawWaveform(ctx, w, h, dpr, data, color, markers, true);
}

export function Timeline() {
  const analysis = usePlayer((s) => s.analysis);
  const duration = usePlayer((s) => s.duration);
  const status = usePlayer((s) => s.status);
  const analysisStatus = usePlayer((s) => s.analysisStatus);
  const progress = usePlayer((s) => s.analysisProgress);
  const lastSeek = usePlayer((s) => s.lastSeek);
  // the scene accent — the same colour as --accent and the exported player
  const accent = useVisual((s) => String(s.scenes[s.sceneId]?.params.primary ?? '#d4ff3a'));
  const baseRef = useRef<HTMLCanvasElement>(null);
  const playedRef = useRef<HTMLCanvasElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  const redraw = useCallback(() => {
    if (baseRef.current) paintWaveform(baseRef.current, analysis, WAVE_BASE, WAVE_MARKERS);
    if (playedRef.current) paintWaveform(playedRef.current, analysis, accent, accent);
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
