/** Waveform with two draggable handles (start / end) for the export range. */
import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { OfflineAnalysisResult } from '../audio/dsp/offlineAnalysis';
import { formatTime } from './format';

export function RangeSelector({
  duration,
  start,
  end,
  analysis,
  accent,
  onChange,
}: {
  duration: number;
  start: number;
  end: number;
  analysis: OfflineAnalysisResult | null;
  accent: string;
  onChange: (start: number, end: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<'start' | 'end' | null>(null);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    const s = duration > 0 ? start / duration : 0;
    const e = duration > 0 ? end / duration : 1;
    if (!analysis) {
      g.fillStyle = 'rgba(236,236,230,0.4)';
      g.fillRect(0, mid, w, Math.max(1, dpr));
    } else {
      let peak = 0;
      for (let b = 0; b < analysis.buckets; b++) peak = Math.max(peak, analysis.waveform[b * 2]);
      const norm = peak > 0 ? 1 / peak : 1;
      for (let x = 0; x < w; x += 2) {
        const b = Math.min(analysis.buckets - 1, Math.floor((x / w) * analysis.buckets));
        const v = analysis.waveform[b * 2 + 1] * norm * 1.4;
        const inside = x / w >= s && x / w <= e;
        g.fillStyle = inside ? accent : 'rgba(236,236,230,0.3)';
        const bh = Math.max(dpr, v * mid * 0.95);
        g.fillRect(x, mid - bh, Math.max(1, dpr), bh * 2);
      }
    }
    g.fillStyle = 'rgba(5,5,5,0.55)';
    g.fillRect(0, 0, s * w, h);
    g.fillRect(e * w, 0, w - e * w, h);
  }, [analysis, duration, start, end, accent]);

  useEffect(() => {
    draw();
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  const timeAt = (clientX: number) => {
    const r = boxRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const t = timeAt(e.clientX);
    drag.current = Math.abs(t - start) <= Math.abs(t - end) ? 'start' : 'end';
    e.currentTarget.setPointerCapture(e.pointerId);
    onMove(e);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const t = timeAt(e.clientX);
    if (drag.current === 'start') onChange(Math.min(t, end - 0.5), end);
    else onChange(start, Math.max(t, start + 0.5));
  };
  const key = (which: 'start' | 'end') => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 5 : 0.5;
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0;
    if (!delta) return;
    e.preventDefault();
    if (which === 'start') onChange(Math.max(0, Math.min(start + delta, end - 0.5)), end);
    else onChange(start, Math.min(duration, Math.max(end + delta, start + 0.5)));
  };
  const pct = (t: number) => `${duration > 0 ? (t / duration) * 100 : 0}%`;

  return (
    <div className="range" ref={boxRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onPointerCancel={() => (drag.current = null)}>
      <canvas ref={canvasRef} className="range-canvas" />
      <span
        className="range-handle"
        style={{ left: pct(start) }}
        role="slider"
        tabIndex={0}
        aria-label="Export start"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(start)}
        aria-valuetext={formatTime(start, true)}
        onKeyDown={key('start')}
      >
        <i>{formatTime(start, true)}</i>
      </span>
      <span
        className="range-handle is-end"
        style={{ left: pct(end) }}
        role="slider"
        tabIndex={0}
        aria-label="Export end"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(end)}
        aria-valuetext={formatTime(end, true)}
        onKeyDown={key('end')}
      >
        <i>{formatTime(end, true)}</i>
      </span>
    </div>
  );
}
