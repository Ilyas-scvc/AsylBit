/**
 * Canvas 2D fallback used when WebGL2 is unavailable or the GPU context is lost for good.
 * It reads the same AudioFrame as the 3D modes and keeps each mode's mapping rules, in a
 * flattened form, so the site stays fully functional.
 */
import { useEffect, useRef } from 'react';
import { analysisHub } from '../../audio/analysis/AnalysisHub';
import { DISPLAY_BANDS, WAVE_POINTS, type AudioFrame } from '../../audio/analysis/frame';
import { EventType } from '../../audio/dsp/events';
import { Spring } from '../../audio/dsp/envelope';
import { useSettings, type VisualSettings } from '../../state/settings';
import { hash01 } from '../hash';
import { setStageCanvas, useRuntime } from '../runtime';
import { telemetry } from '../telemetry';
import { useReducedMotion } from '../useReducedMotion';

interface DrawState {
  phase: number;
  spin: number;
  scale: Spring;
  rows: Float32Array;
  rowHead: number;
  rowTimer: number;
  snareSeen: number;
  shockAge: number;
}

const ROWS = 34;
const RIDGE = new Float32Array(90 * 2);

export function Canvas2DRenderer({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();
  const motionRef = useRef(reducedMotion);
  motionRef.current = reducedMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    setStageCanvas(canvas);
    const resize = () => {
      // layout size (unaffected by the export scale transform); 1:1 pixels while exporting
      const dpr = useRuntime.getState().exportConfig ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const state: DrawState = {
      phase: 0,
      spin: 0,
      scale: new Spring(1, 260, 24),
      rows: new Float32Array(ROWS * DISPLAY_BANDS),
      rowHead: 0,
      rowTimer: 0,
      snareSeen: 0,
      shockAge: 10,
    };
    let raf = 0;
    let frames = 0;
    let since = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      analysisHub.tick(now);
      draw(ctx, canvas.width, canvas.height, analysisHub.frame, useSettings.getState(), state, motionRef.current);
      telemetry.rotation = ((((state.spin * 180) / Math.PI) % 360) + 360) % 360;
      telemetry.tilt = 0;
      frames++;
      if (now - since >= 1000) {
        useRuntime.setState({ fps: Math.round((frames * 1000) / (now - since)) });
        frames = 0;
        since = now;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      setStageCanvas(null);
    };
  }, [active]);

  return <canvas ref={canvasRef} className="stage-canvas2d" aria-hidden="true" />;
}

function draw(ctx: CanvasRenderingContext2D, w: number, h: number, f: AudioFrame, s: VisualSettings, st: DrawState, reduced: boolean) {
  const dt = f.dt;
  const motion = reduced ? 0.45 : 1;
  const I = s.intensity;
  ctx.fillStyle = s.background;
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const unit = Math.min(w, h) * 0.2;
  st.phase += dt * (0.2 + 0.6 * f.mid * f.activity) * motion;
  st.spin += dt * 0.1 * s.rotationSpeed * motion;
  const sc = st.scale.step(1 + (0.13 * f.bass * I + 0.11 * f.kick) * motion, dt);
  ctx.lineCap = 'round';

  if (s.mode === 'pulse') {
    // contour stack of a noisy closed curve: bass = size, mid = folding, high = ripple
    const contours = 9;
    for (let c = 0; c < contours; c++) {
      const k = c / (contours - 1);
      const base = unit * sc * (0.55 + 0.5 * k);
      ctx.beginPath();
      const steps = 160;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2 + st.spin;
        const n1 = Math.sin(a * 3 + st.phase * 1.3 + c * 0.4) * (0.05 + 0.1 * f.bass * I);
        const n2 = Math.sin(a * 7 - st.phase * 1.9 + c) * (0.01 + 0.08 * f.mid * I);
        const n3 = Math.sin(a * 23 + st.phase * 6) * 0.025 * f.high * I;
        const r = base * (1 + (n1 + n2 + n3) * motion);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * 0.92;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = c === contours - 1 ? s.accent : `rgba(236,236,230,${0.12 + 0.5 * (1 - k) * (0.4 + 0.6 * f.activity)})`;
      ctx.globalAlpha = c === contours - 1 ? 0.3 + 0.6 * f.kick : 1;
      ctx.lineWidth = Math.max(1, unit * 0.006);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // high-frequency particle shell
    const count = Math.round(260 * s.particleDensity);
    for (let i = 0; i < count; i++) {
      const seed = hash01(i);
      const on = Math.max(0, Math.min(1, (f.high * 1.05 + f.hat * 0.7 - seed * 0.95) / 0.18));
      const a = hash01(i * 3.7) * Math.PI * 2 + st.spin * 0.5;
      const r = unit * sc * (1.35 + 0.55 * hash01(i * 9.1));
      ctx.fillStyle = seed > 0.72 ? s.accent : '#ecece6';
      ctx.globalAlpha = 0.08 + on * 0.8;
      ctx.fillRect(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.5 + on * 1.5, 1.5 + on * 1.5);
    }
    ctx.globalAlpha = 1;
  } else if (s.mode === 'radial') {
    const N = DISPLAY_BANDS * 2;
    const r0 = unit * 1.05 * sc;
    for (let i = 0; i < N; i++) {
      const b = i < DISPLAY_BANDS ? i : N - 1 - i;
      const v = f.spectrum[b];
      const len = unit * (0.03 + Math.pow(v, 1.3) * (1.15 - 0.62 * (b / (DISPLAY_BANDS - 1))) * I);
      const a = -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / N + st.spin * 0.5;
      ctx.strokeStyle = v > 0.45 ? s.accent : '#ecece6';
      ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, v);
      ctx.lineWidth = Math.max(1, unit * 0.008);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
      ctx.stroke();
    }
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#ecece6';
    ctx.beginPath();
    for (let i = 0; i <= WAVE_POINTS; i++) {
      const j = i % WAVE_POINTS;
      const a = (j / WAVE_POINTS) * Math.PI * 2;
      const r = r0 * 0.6 + f.waveform[j] * unit * 0.28 * f.activity * motion;
      if (i === 0) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.stroke();
    if (f.counts[EventType.SNARE] !== st.snareSeen) {
      st.snareSeen = f.counts[EventType.SNARE];
      st.shockAge = 0;
    }
    st.shockAge += dt;
    const life = Math.max(0, 1 - st.shockAge / 0.55);
    if (life > 0) {
      ctx.globalAlpha = life * life * 0.6 * (reduced ? 0.4 : 1);
      ctx.strokeStyle = s.accent;
      ctx.beginPath();
      ctx.arc(cx, cy, r0 + st.shockAge * unit * 2.6 * motion, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else {
    // ridge lines: each row is a past spectrum, drawn back-to-front with simple perspective
    st.rowTimer += dt * motion;
    while (st.rowTimer >= 1 / 24) {
      st.rowTimer -= 1 / 24;
      st.rowHead = (st.rowHead + 1) % ROWS;
      st.rows.set(f.spectrum, st.rowHead * DISPLAY_BANDS);
    }
    const cols = 90;
    for (let r = ROWS - 1; r >= 0; r--) {
      const slot = ((st.rowHead - r + ROWS) % ROWS) * DISPLAY_BANDS;
      const depth = r / ROWS;
      const persp = 1 / (1 + depth * 2.2);
      const baseY = cy + h * 0.32 * persp - h * 0.12;
      const width = w * 0.9 * persp;
      for (let c = 0; c < cols; c++) {
        const x01 = (c / (cols - 1)) * 2 - 1;
        const bf = Math.pow(Math.abs(x01), 0.85) * (DISPLAY_BANDS - 1);
        const v = st.rows[slot + Math.round(bf)];
        let y = Math.pow(v, 1.35) * (1.25 - 0.85 * Math.abs(x01));
        y += (f.bass * 0.42 * I + f.kick * 0.2) * Math.exp(-x01 * x01 * 2.2) * (r === 0 ? 1 : 0);
        y += (1 - f.activity) * 0.07 * Math.sin(x01 * 2.4 + st.phase * 0.5 + r * 0.3);
        RIDGE[c * 2] = cx + x01 * width * 0.5;
        RIDGE[c * 2 + 1] = baseY - y * unit * 1.2 * persp * I;
      }
      // occlude the rows behind (classic ridge-line look), then stroke the crest
      ctx.beginPath();
      ctx.moveTo(RIDGE[0], RIDGE[1]);
      for (let c = 1; c < cols; c++) ctx.lineTo(RIDGE[c * 2], RIDGE[c * 2 + 1]);
      ctx.lineTo(RIDGE[(cols - 1) * 2], baseY + 4);
      ctx.lineTo(RIDGE[0], baseY + 4);
      ctx.closePath();
      ctx.globalAlpha = 1;
      ctx.fillStyle = s.background;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(RIDGE[0], RIDGE[1]);
      for (let c = 1; c < cols; c++) ctx.lineTo(RIDGE[c * 2], RIDGE[c * 2 + 1]);
      ctx.strokeStyle = r < 2 ? s.accent : '#ecece6';
      ctx.globalAlpha = Math.pow(1 - depth, 1.3) * 0.85;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
