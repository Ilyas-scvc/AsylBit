/**
 * Core types of the BEAT//FORM visualizer engine.
 *
 * A scene is a self-contained three.js scene graph plus an `update(ctx)` that derives its
 * whole visual state from the frame context: music time, a fixed `dt`, audio features and
 * resolved parameters. Scenes never read wall-clock time, `requestAnimationFrame` or
 * `Math.random`, so the same inputs always render the same pixels — which is what lets the
 * live stage and the offline video renderer share one implementation.
 */
import type * as THREE from 'three';

export type ParamValue = number | boolean | string;
export type ParamValues = Record<string, ParamValue>;

export type ParamGroup = 'geometry' | 'animation' | 'audio' | 'camera' | 'colors';
export type ParamType = 'number' | 'boolean' | 'select' | 'color';

export interface ParamOption {
  value: string;
  label: string;
}

export interface ParamDef {
  key: string;
  label: string;
  group: ParamGroup;
  type: ParamType;
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: ParamOption[];
  /** numeric params that can be driven by the modulation system */
  modulatable?: boolean;
  unit?: string;
  hint?: string;
}

export type SceneCategory = 'geometry' | 'particles' | 'waveforms' | 'abstract' | 'experimental';

export const SCENE_CATEGORIES: { id: SceneCategory; label: string }[] = [
  { id: 'geometry', label: 'GEOMETRY' },
  { id: 'particles', label: 'PARTICLES' },
  { id: 'waveforms', label: 'WAVEFORMS' },
  { id: 'abstract', label: 'ABSTRACT' },
  { id: 'experimental', label: 'EXPERIMENTAL' },
];

/** Audio features after the per-scene audio-reaction settings have been applied. */
export interface SceneAudio {
  /** music / playback time in seconds */
  time: number;
  playing: boolean;
  hasTrack: boolean;
  /** 0..1, eases toward 1 while music is audible */
  activity: number;
  sub: number;
  bass: number;
  mids: number;
  treble: number;
  rms: number;
  flux: number;
  /** decaying impulse envelopes */
  kick: number;
  snare: number;
  hat: number;
  tone: number;
  /** monotonic event counters, for one-shot reactions */
  kickCount: number;
  snareCount: number;
  hatCount: number;
  /** 96 log-spaced bands, 0..~1.25 */
  spectrum: Float32Array;
  peaks: Float32Array;
  /** 256 samples, -1..1 */
  waveform: Float32Array;
}

export interface ParamReader {
  num(key: string): number;
  bool(key: string): boolean;
  str(key: string): string;
  has(key: string): boolean;
}

export interface Palette {
  primary: THREE.Color;
  secondary: THREE.Color;
  background: THREE.Color;
  /** 0 mono · 1 blend · 2 frequency · 3 spectrum */
  gradient: number;
}

export interface QualityProfile {
  id: PerformancePreset;
  /** geometry level of detail */
  detail: 'low' | 'high';
  /** multiplier for particle / line counts */
  particles: number;
  /** maximum device pixel ratio for the live stage */
  maxDpr: number;
  /** resolution scale of post-processing targets */
  postScale: number;
  bloomLevels: number;
  maxEffects: number;
  msaa: number;
}

export type PerformancePreset = 'eco' | 'balanced' | 'quality' | 'ultra';

export interface SceneFrameContext {
  /** music / playback time (s) */
  time: number;
  /** monotonic visual clock (s): sum of dt since the engine started */
  clock: number;
  /** step since the previous frame (s); fixed 1/fps while exporting */
  dt: number;
  audio: SceneAudio;
  params: ParamReader;
  palette: Palette;
  camera: THREE.PerspectiveCamera;
  width: number;
  height: number;
  aspect: number;
  pixelRatio: number;
  quality: QualityProfile;
  reducedMotion: boolean;
  /** normalized pointer (-1..1); always 0 while exporting */
  pointer: { x: number; y: number };
  exporting: boolean;
}

export interface SceneInstance {
  readonly root: THREE.Object3D;
  update(ctx: SceneFrameContext): void;
  dispose(): void;
  /** optional readout for the HUD (degrees) */
  telemetry?: { rotation: number; tilt: number };
}

export interface SceneEnv {
  quality: QualityProfile;
  renderer: THREE.WebGLRenderer;
}

/** Either a standard parameter key (optionally with overrides) or a scene-specific definition. */
export type SceneParamSpec = string | (Partial<ParamDef> & { key: string });

export interface SceneDefinition {
  id: string;
  index: string;
  name: string;
  short: string;
  description: string;
  category: SceneCategory;
  params: SceneParamSpec[];
  /** "audio → visual" mapping lines for the docs / browser */
  mapping: [string, string][];
  /** which Canvas 2D fallback mode represents this scene without WebGL */
  fallback2D: 'pulse' | 'radial' | 'wave';
}

/**
 * Builds a scene instance. Factories live with the three.js implementations and are only
 * imported by the engine, so metadata (registry, inspector, presets) stays three-free.
 */
export type SceneFactory = (env: SceneEnv) => SceneInstance;
