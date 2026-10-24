/**
 * Per-frame parameter resolution, shared by the live stage and the video renderer (no GPU):
 *
 *   base values ──► source features (base AUDIO REACTION) ──► modulation ──► resolved values
 *                                                                        └──► scene features
 *                                                                             (resolved AUDIO REACTION)
 *
 * Modulation sources always read the features computed with the *base* audio settings, so a
 * modulated BASS / KICK IMPACT / NOISE GATE … changes what the scene receives without feeding
 * back into its own source signal, and every binding's envelope advances exactly once a frame.
 */
import type { AudioFrame } from '../audio/analysis/frame';
import { AudioFeatureProvider } from './features';
import { ModulationEngine, type ModulationBinding } from './modulation';
import { ValuesReader } from './params';
import { EFFECT_MAP, budgetedEffects, type EffectInstance } from './post/effects';
import type { ParamDef, ParamValues, SceneAudio } from './types';

export interface ResolveInput {
  frame: AudioFrame;
  /** music time (s) — also drives the LFO */
  time: number;
  dt: number;
  params: ParamValues;
  modulations: readonly ModulationBinding[];
  post: readonly EffectInstance[];
  maxEffects: number;
}

export class FrameResolver {
  readonly modulation = new ModulationEngine();
  /** features with the base audio settings: the modulation sources */
  readonly sourceFeatures = new AudioFeatureProvider();
  /** features with the resolved (modulated) audio settings: what the scene receives */
  readonly features = new AudioFeatureProvider();
  /** resolved scene parameters of the last frame */
  readonly values: ParamValues = {};
  /** reader over `values` */
  readonly reader = new ValuesReader();
  /** active effects with their resolved parameters */
  readonly effects: EffectInstance[] = [];
  private readonly base: ParamValues = {};
  private readonly baseReader = new ValuesReader();
  private readonly fxDefs = new Map<string, ParamDef>();

  resolve(defs: Map<string, ParamDef>, input: ResolveInput): SceneAudio {
    const { frame, time, dt } = input;

    // base values: the snapshot, with defaults for anything it lacks
    for (const k of Object.keys(this.base)) if (!defs.has(k)) delete this.base[k];
    for (const [k, d] of defs) this.base[k] = input.params[k] ?? d.default;
    this.baseReader.values = this.base;
    const source = this.sourceFeatures.build(frame, this.baseReader);
    source.time = time;

    // modulated scene parameters (one envelope step per binding)
    for (const k of Object.keys(this.values)) if (!defs.has(k)) delete this.values[k];
    Object.assign(this.values, this.base);
    this.modulation.apply(input.modulations, defs, this.base, source, time, dt, this.values);

    // post stack with its own modulated parameters
    const fx = budgetedEffects(input.post as EffectInstance[], input.maxEffects);
    this.effects.length = 0;
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
    if (fx.length) this.modulation.apply(input.modulations, this.fxDefs, fxBase, source, time, dt, fxOut);
    for (const e of fx) {
      const params: ParamValues = {};
      for (const d of EFFECT_MAP.get(e.type)?.params ?? []) params[d.key] = fxOut[`fx:${e.id}:${d.key}`];
      this.effects.push({ ...e, params });
    }

    // what the scene receives: features with the resolved AUDIO REACTION settings
    this.reader.values = this.values;
    const audio = this.features.build(frame, this.reader);
    audio.time = time;
    return audio;
  }

  reset(): void {
    this.modulation.reset();
  }
}
