/**
 * Runtime rendering state: active renderer, adaptive pixel ratio / detail (measured frame
 * times), WebGL context health, and whether an offline export currently owns the GPU.
 */
import { create } from 'zustand';
import { qualityProfile } from '../engine/quality';
import type { PerformancePreset, QualityProfile } from '../engine/types';

export type RendererKind = 'webgl' | 'canvas2d';

interface RuntimeState {
  renderer: RendererKind;
  /** why the 2D fallback is active (if it is) */
  fallbackReason: string | null;
  contextLost: boolean;
  /** governor multiplier for the pixel-ratio cap (1 = preset maximum) */
  dprScale: number;
  /** governor fell back to low geometry detail */
  degraded: boolean;
  fps: number;
  stageVisible: boolean;
  /** legacy real-time recorder: renders the stage at a fixed size */
  exportConfig: { width: number; height: number; fps: number } | null;
  /** offline renderer is running: the live loop pauses to leave the GPU to it */
  offlineExport: boolean;
}

export function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function initialRenderer(): { renderer: RendererKind; reason: string | null } {
  const forced = new URLSearchParams(window.location.search).get('renderer');
  if (forced === '2d') return { renderer: 'canvas2d', reason: 'FORCED BY ?renderer=2d' };
  if (!supportsWebGL2()) return { renderer: 'canvas2d', reason: 'WEBGL2 UNAVAILABLE' };
  return { renderer: 'webgl', reason: null };
}

const init = typeof window !== 'undefined' ? initialRenderer() : { renderer: 'webgl' as const, reason: null };

export const useRuntime = create<RuntimeState>()(() => ({
  renderer: init.renderer,
  fallbackReason: init.reason,
  contextLost: false,
  dprScale: 1,
  degraded: false,
  fps: 0,
  stageVisible: true,
  exportConfig: null,
  offlineExport: false,
}));

/** Effective live quality profile: the preset, possibly degraded by the governor. */
export function liveProfile(preset: PerformancePreset, degraded: boolean): QualityProfile {
  const base = qualityProfile(preset);
  return degraded && base.detail === 'high' ? { ...base, detail: 'low', particles: base.particles * 0.6, msaa: 0 } : base;
}

export function livePixelRatio(preset: PerformancePreset, dprScale: number): number {
  const device = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.max(0.75, Math.min(device, qualityProfile(preset).maxDpr) * dprScale);
}

export function fallBackTo2D(reason: string): void {
  useRuntime.setState({ renderer: 'canvas2d', fallbackReason: reason, contextLost: false });
}

/** The canvas element of the active renderer (WebGL or 2D), used for real-time capture. */
let stageCanvas: HTMLCanvasElement | null = null;
export function setStageCanvas(canvas: HTMLCanvasElement | null): void {
  stageCanvas = canvas;
}
export function getStageCanvas(): HTMLCanvasElement | null {
  return stageCanvas && stageCanvas.isConnected ? stageCanvas : null;
}

/**
 * WebGL context-loss policy: wait `timeoutMs` for the browser to restore the context; if
 * it does not, give up on WebGL. Timer functions are injectable for tests.
 */
export class ContextLossMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  lost = false;

  constructor(
    private readonly onState: (lost: boolean) => void,
    private readonly onGiveUp: () => void,
    private readonly timeoutMs = 3000,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}

  handleLost(): void {
    this.lost = true;
    this.onState(true);
    if (this.timer) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.lost) this.onGiveUp();
    }, this.timeoutMs);
  }

  handleRestored(): void {
    this.lost = false;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
    this.onState(false);
  }

  dispose(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }
}

/**
 * Frame-rate governor for the live stage: after `slowSeconds` consecutive seconds below
 * `minFps` it first lowers the pixel ratio (to a floor), then the geometry detail.
 */
export class FrameGovernor {
  private frames = 0;
  private time = 0;
  private slow = 0;

  constructor(
    private readonly minFps = 42,
    private readonly slowSeconds = 3,
  ) {}

  /** Returns the measured fps once per second, otherwise null. */
  sample(dt: number, onSlow: () => void): number | null {
    this.frames++;
    this.time += dt;
    if (this.time < 1) return null;
    const fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    this.slow = fps < this.minFps ? this.slow + 1 : 0;
    if (this.slow >= this.slowSeconds) {
      this.slow = 0;
      onSlow();
    }
    return fps;
  }

  reset(): void {
    this.frames = this.time = this.slow = 0;
  }
}
