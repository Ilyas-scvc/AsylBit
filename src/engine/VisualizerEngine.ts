/**
 * VisualizerEngine: one three.js renderer + the active scene + modulation + post stack.
 *
 *   input (AudioFrame, time, dt, visual state)
 *     → AudioFeatureProvider (scene audio settings)
 *     → ModulationEngine (resolved parameters)
 *     → SceneController.update (scene sets uniforms / camera)
 *     → PostProcessingPipeline (effects + grade) → canvas
 *
 * The same class drives the live stage (visible canvas, rAF loop) and the offline video
 * renderer (dedicated canvas at the export resolution, fixed dt). Nothing here reads the
 * wall clock, so a given input sequence always produces the same frames.
 */
import * as THREE from 'three';
import type { AudioFrame } from '../audio/analysis/frame';
import { GRADIENT_INDEX, HexColor } from './colors';
import { AudioFeatureProvider } from './features';
import { ModulationEngine, type ModulationBinding } from './modulation';
import { getSceneSchema, schemaMap, ValuesReader } from './params';
import { EFFECT_MAP, budgetedEffects, type EffectInstance } from './post/effects';
import { PostProcessingPipeline } from './post/pipeline';
import { SCENE_FACTORIES } from './scenes/factories';
import { getScene } from './scenes/registry';
import type { ParamDef, ParamValues, Palette, QualityProfile, SceneDefinition, SceneFrameContext, SceneInstance } from './types';

THREE.ColorManagement.enabled = false;

export interface VisualSnapshot {
  sceneId: string;
  params: ParamValues;
  modulations: readonly ModulationBinding[];
  post: readonly EffectInstance[];
}

export interface EngineFrameInput {
  frame: AudioFrame;
  /** music time (s) */
  time: number;
  dt: number;
  visual: VisualSnapshot;
  reducedMotion: boolean;
  pointer?: { x: number; y: number };
  exporting?: boolean;
  /** skip drawing (pre-roll steps that only advance state) */
  skipRender?: boolean;
}

export interface EngineOptions {
  quality: QualityProfile;
  preserveDrawingBuffer?: boolean;
  antialias?: boolean;
  /** cross-fade length when switching scenes (0 for exports) */
  sceneFade?: number;
}

export class SceneController {
  def: SceneDefinition | null = null;
  instance: SceneInstance | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
  ) {}

  setScene(id: string, quality: QualityProfile): boolean {
    const def = getScene(id);
    if (this.def === def && this.instance) return false;
    this.dispose();
    this.def = def;
    const create = SCENE_FACTORIES[def.id];
    if (!create) throw new Error(`Scene "${def.id}" has no factory`);
    this.instance = create({ quality, renderer: this.renderer });
    this.scene.add(this.instance.root);
    return true;
  }

  /** Rebuild the current scene (e.g. after the detail level changed). */
  rebuild(quality: QualityProfile): void {
    const id = this.def?.id;
    this.dispose();
    if (id) this.setScene(id, quality);
  }

  dispose(): void {
    if (this.instance) {
      this.scene.remove(this.instance.root);
      this.instance.dispose();
    }
    this.instance = null;
    this.def = null;
  }
}

export class VisualizerEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
  readonly controller: SceneController;
  readonly post: PostProcessingPipeline;
  readonly modulation = new ModulationEngine();
  readonly features = new AudioFeatureProvider();
  quality: QualityProfile;
  clock = 0;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private fade = 1;
  private readonly sceneFade: number;
  private readonly reader = new ValuesReader();
  private readonly resolved: ParamValues = {};
  private readonly fxResolved: EffectInstance[] = [];
  private readonly fxDefs = new Map<string, ParamDef>();
  private readonly palette: Palette = { primary: new THREE.Color(), secondary: new THREE.Color(), background: new THREE.Color(), gradient: 1 };
  private readonly hex = { primary: new HexColor(), secondary: new HexColor(), background: new HexColor() };
  private schemaFor: SceneDefinition | null = null;
  private defs = new Map<string, ParamDef>();

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options: EngineOptions) {
    this.quality = options.quality;
    this.sceneFade = options.sceneFade ?? 0.45;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: options.antialias ?? true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = true;
    this.controller = new SceneController(this.scene, this.renderer);
    this.post = new PostProcessingPipeline(this.renderer, this.quality);
  }

  get size(): { width: number; height: number; pixelRatio: number } {
    return { width: this.width, height: this.height, pixelRatio: this.pixelRatio };
  }

  /** CSS size + pixel ratio (live) or exact pixel size with ratio 1 (export). */
  setSize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.pixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(Math.max(1, cssWidth), Math.max(1, cssHeight), false);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = buf.x;
    this.height = buf.y;
    this.camera.aspect = this.width / Math.max(1, this.height);
    this.camera.updateProjectionMatrix();
    this.post.setSize(this.width, this.height);
  }

  setQuality(q: QualityProfile): void {
    const rebuild = q.detail !== this.quality.detail || q.particles !== this.quality.particles;
    this.quality = q;
    this.post.setQuality(q);
    if (rebuild) this.controller.rebuild(q);
  }

  /** Reset all accumulated state (exports start from here). */
  reset(): void {
    this.clock = 0;
    this.modulation.reset();
    this.post.resetHistory();
    this.controller.rebuild(this.quality);
    this.fade = 1;
  }

  private schema(def: SceneDefinition): Map<string, ParamDef> {
    if (this.schemaFor !== def) {
      this.schemaFor = def;
      this.defs = schemaMap(getSceneSchema(def));
    }
    return this.defs;
  }

  render(input: EngineFrameInput): void {
    const { visual } = input;
    const dt = Math.max(0, input.dt);
    this.clock += dt;

    if (this.controller.setScene(visual.sceneId, this.quality)) {
      this.fade = input.exporting ? 1 : 0;
      this.post.resetHistory();
    }
    const def = this.controller.def!;
    const instance = this.controller.instance!;
    const defs = this.schema(def);

    // base values → audio features (with the scene's audio settings) → modulation
    for (const k of Object.keys(this.resolved)) if (!defs.has(k)) delete this.resolved[k];
    for (const [k, d] of defs) this.resolved[k] = visual.params[k] ?? d.default;
    this.reader.values = this.resolved;
    const audio = this.features.build(input.frame, this.reader);
    audio.time = input.time;
    this.modulation.apply(visual.modulations, defs, visual.params, audio, input.time, dt, this.resolved);

    // post stack with its own modulated parameters
    const fx = budgetedEffects(visual.post as EffectInstance[], this.quality.maxEffects);
    this.fxResolved.length = 0;
    this.fxDefs.clear();
    const fxBase: ParamValues = {};
    for (const e of fx) {
      for (const d of EFFECT_MAP.get(e.type)?.params ?? []) {
        const key = `fx:${e.id}:${d.key}`;
        this.fxDefs.set(key, d);
        fxBase[key] = e.params[d.key] ?? d.default;
      }
    }
    const fxOut: ParamValues = { ...fxBase };
    if (fx.length) this.modulation.apply(visual.modulations, this.fxDefs, fxBase, audio, input.time, dt, fxOut);
    for (const e of fx) {
      const params: ParamValues = {};
      for (const d of EFFECT_MAP.get(e.type)?.params ?? []) params[d.key] = fxOut[`fx:${e.id}:${d.key}`];
      this.fxResolved.push({ ...e, params });
    }

    this.palette.primary.copy(this.hex.primary.set(String(this.resolved.primary)));
    this.palette.secondary.copy(this.hex.secondary.set(String(this.resolved.secondary)));
    this.palette.background.copy(this.hex.background.set(String(this.resolved.background)));
    this.palette.gradient = GRADIENT_INDEX[String(this.resolved.gradient)] ?? 1;
    this.renderer.setClearColor(this.palette.background, 1);

    const ctx: SceneFrameContext = {
      time: input.time,
      clock: this.clock,
      dt,
      audio,
      params: this.reader,
      palette: this.palette,
      camera: this.camera,
      width: this.width,
      height: this.height,
      aspect: this.width / Math.max(1, this.height),
      pixelRatio: this.pixelRatio,
      quality: this.quality,
      reducedMotion: input.reducedMotion,
      pointer: input.pointer && !input.exporting ? input.pointer : ZERO_POINTER,
      exporting: !!input.exporting,
    };
    instance.update(ctx);

    if (this.sceneFade > 0 && this.fade < 1) this.fade = Math.min(1, this.fade + dt / this.sceneFade);
    if (input.skipRender) return;
    this.post.render(
      this.scene,
      this.camera,
      this.fxResolved,
      {
        brightness: this.reader.num('brightness'),
        contrast: this.reader.num('contrast'),
        saturation: this.reader.num('saturation'),
        fade: this.fade * this.fade * (3 - 2 * this.fade),
      },
      { time: input.time, clock: this.clock, dt, kick: audio.kick },
    );
  }

  get telemetry(): { rotation: number; tilt: number } | undefined {
    return this.controller.instance?.telemetry;
  }

  /** Resolved (modulated) value of a parameter in the last frame, for the Inspector. */
  resolvedValue(key: string): number | undefined {
    const v = this.resolved[key];
    return typeof v === 'number' ? v : undefined;
  }

  dispose(): void {
    this.controller.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }
}

const ZERO_POINTER = { x: 0, y: 0 };
