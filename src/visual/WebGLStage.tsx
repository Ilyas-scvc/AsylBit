/**
 * Live WebGL stage: hosts a VisualizerEngine on a visible canvas and runs the frame loop
 * (analysis tick → engine render). Loaded lazily so the page paints before three.js loads.
 *
 * Hiding the UI, changing the preview frame or opening panels only resizes the canvas —
 * the WebGL context is created once and kept.
 */
import { useEffect, useRef } from 'react';
import { analysisHub } from '../audio/analysis/AnalysisHub';
import { VisualizerEngine } from '../engine/VisualizerEngine';
import { useSettings } from '../state/settings';
import { useVisual, visualSnapshot } from '../state/visual';
import { setLiveEngine } from './liveEngine';
import { ContextLossMonitor, FrameGovernor, fallBackTo2D, liveProfile, livePixelRatio, setStageCanvas, useRuntime } from './runtime';
import { telemetry } from './telemetry';
import { systemPrefersReducedMotion } from './useReducedMotion';
import { resolveReducedMotion } from '../state/settings';

export default function WebGLStage({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const settings = useSettings.getState();
    let engine: VisualizerEngine;
    try {
      engine = new VisualizerEngine(canvas, { quality: liveProfile(settings.performance, useRuntime.getState().degraded) });
    } catch (err) {
      console.error('[BEAT//FORM] WebGL engine failed to start', err);
      fallBackTo2D('WEBGL INITIALISATION FAILED');
      return;
    }
    setStageCanvas(canvas);
    setLiveEngine(engine);
    canvas.setAttribute('aria-hidden', 'true');

    const resize = () => {
      const s = useSettings.getState();
      const rt = useRuntime.getState();
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dpr = rt.exportConfig ? 1 : livePixelRatio(s.performance, rt.dprScale);
      engine.setSize(w, h, dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const applyQuality = () => {
      const s = useSettings.getState();
      engine.setQuality(liveProfile(s.performance, useRuntime.getState().degraded));
      resize();
    };
    const unsubSettings = useSettings.subscribe((s, prev) => {
      if (s.performance !== prev.performance) {
        useRuntime.setState({ dprScale: 1, degraded: false });
        applyQuality();
      }
    });
    const unsubRuntime = useRuntime.subscribe((s, prev) => {
      if (s.dprScale !== prev.dprScale || s.exportConfig !== prev.exportConfig) resize();
      if (s.degraded !== prev.degraded) applyQuality();
    });

    // ---- context loss ----------------------------------------------------------------
    const monitor = new ContextLossMonitor(
      (lost) => useRuntime.setState({ contextLost: lost }),
      () => fallBackTo2D('WEBGL CONTEXT LOST'),
    );
    const onLost = (e: Event) => {
      e.preventDefault();
      monitor.handleLost();
    };
    const onRestored = () => monitor.handleRestored();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    // ---- pointer (hover parallax) ----------------------------------------------------
    const pointer = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1));
      pointer.y = Math.max(-1, Math.min(1, -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1)));
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    // ---- frame loop ------------------------------------------------------------------
    const governor = new FrameGovernor();
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const rt = useRuntime.getState();
      if (rt.offlineExport || monitor.lost) return;
      if (!activeRef.current && !rt.exportConfig) return;
      analysisHub.tick(now);
      const f = analysisHub.frame;
      const s = useSettings.getState();
      engine.render({
        frame: f,
        time: f.time,
        dt: f.dt,
        visual: visualSnapshot(useVisual.getState()),
        reducedMotion: resolveReducedMotion(s.reducedMotion, systemPrefersReducedMotion()),
        pointer,
      });
      const t = engine.telemetry;
      if (t) {
        telemetry.rotation = t.rotation;
        telemetry.tilt = t.tilt;
      }
      const fps = governor.sample(f.dt, () => {
        if (s.performance === 'ultra' || rt.exportConfig || document.hidden) return;
        if (rt.dprScale > 0.62) useRuntime.setState({ dprScale: Math.max(0.6, rt.dprScale - 0.15) });
        else if (!rt.degraded) useRuntime.setState({ degraded: true });
      });
      if (fps !== null) useRuntime.setState({ fps: Math.round(fps) });
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubSettings();
      unsubRuntime();
      monitor.dispose();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      window.removeEventListener('pointermove', onMove);
      setLiveEngine(null);
      setStageCanvas(null);
      engine.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="stage-canvas" />;
}
