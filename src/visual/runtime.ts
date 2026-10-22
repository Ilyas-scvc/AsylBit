/**
 * Runtime rendering state: which renderer is active, effective detail level and pixel
 * ratio (adapted to the device and measured frame times), and WebGL context health.
 */
import { create } from 'zustand';
import type { QualitySetting } from '../state/settings';

export type RendererKind = 'webgl' | 'canvas2d';
export type Detail = 'high' | 'low';

interface RuntimeState {
  renderer: RendererKind;
  /** why the 2D fallback is active (if it is) */
  fallbackReason: string | null;
  contextLost: boolean;
  /** detail level chosen automatically (used when quality setting is 'auto') */
  autoDetail: Detail;
  /** current device pixel ratio cap */
  dpr: number;
  fps: number;
  stageVisible: boolean;
  /** set while a video export renders the stage at a fixed resolution */
  exportConfig: { width: number; height: number; fps: number } | null;
}

/** The canvas element of the active renderer (WebGL or 2D), used for video capture. */
let stageCanvas: HTMLCanvasElement | null = null;
export function setStageCanvas(canvas: HTMLCanvasElement | null): void {
  stageCanvas = canvas;
}
export function getStageCanvas(): HTMLCanvasElement | null {
  return stageCanvas && stageCanvas.isConnected ? stageCanvas : null;
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

/** Rough device tier from cheap signals; refined at runtime by the frame-time monitor. */
export function guessDetail(): Detail {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 8;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const small = Math.min(window.screen.width, window.screen.height) < 600;
  if (cores <= 4 || memory <= 4 || (coarse && small)) return 'low';
  return 'high';
}

export function maxDprFor(detail: Detail): number {
  const device = window.devicePixelRatio || 1;
  return Math.min(device, detail === 'high' ? 2 : 1.5);
}

function initialRenderer(): { renderer: RendererKind; reason: string | null } {
  const forced = new URLSearchParams(window.location.search).get('renderer');
  if (forced === '2d') return { renderer: 'canvas2d', reason: 'FORCED BY ?renderer=2d' };
  if (!supportsWebGL2()) return { renderer: 'canvas2d', reason: 'WEBGL2 UNAVAILABLE' };
  return { renderer: 'webgl', reason: null };
}

const init = typeof window !== 'undefined' ? initialRenderer() : { renderer: 'webgl' as const, reason: null };
const detail = typeof window !== 'undefined' ? guessDetail() : 'high';

export const useRuntime = create<RuntimeState>()(() => ({
  renderer: init.renderer,
  fallbackReason: init.reason,
  contextLost: false,
  autoDetail: detail,
  dpr: typeof window !== 'undefined' ? maxDprFor(detail) : 1,
  fps: 0,
  stageVisible: true,
  exportConfig: null,
}));

export function effectiveDetail(quality: QualitySetting, auto: Detail): Detail {
  return quality === 'auto' ? auto : quality;
}

export function fallBackTo2D(reason: string): void {
  useRuntime.setState({ renderer: 'canvas2d', fallbackReason: reason, contextLost: false });
}
