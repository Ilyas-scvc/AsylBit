/**
 * SceneRegistry: the single list of available scenes. Adding a scene = writing a
 * SceneDefinition (defs/), a factory (factories.ts) and registering it here; the browser,
 * inspector, presets, live stage and video renderer all discover it from the registry.
 * Definitions are plain data, so this module never pulls three.js into the main bundle.
 */
import { getSceneSchema } from '../params';
import type { SceneCategory, SceneDefinition } from '../types';
import { audioTunnel } from './defs/audioTunnel';
import { cosmicRings } from './defs/cosmicRings';
import { fractalBloom } from './defs/fractalBloom';
import { particleCloud } from './defs/particleCloud';
import { plasmaFlow } from './defs/plasmaFlow';
import { pulseObject } from './defs/pulseObject';
import { radialSpectrum } from './defs/radialSpectrum';
import { reactiveMesh } from './defs/reactiveMesh';
import { waveField } from './defs/waveField';

export class SceneRegistry {
  private readonly scenes = new Map<string, SceneDefinition>();

  register(def: SceneDefinition): void {
    if (!/^[a-z0-9-]{2,40}$/.test(def.id)) throw new Error(`Invalid scene id "${def.id}"`);
    if (this.scenes.has(def.id)) throw new Error(`Scene "${def.id}" is already registered`);
    getSceneSchema(def); // validates every parameter spec eagerly
    this.scenes.set(def.id, def);
  }

  get(id: string): SceneDefinition | undefined {
    return this.scenes.get(id);
  }

  has(id: string): boolean {
    return this.scenes.has(id);
  }

  list(category?: SceneCategory): SceneDefinition[] {
    const all = [...this.scenes.values()].sort((a, b) => a.index.localeCompare(b.index));
    return category ? all.filter((s) => s.category === category) : all;
  }

  get size(): number {
    return this.scenes.size;
  }
}

export const sceneRegistry = new SceneRegistry();
for (const def of [pulseObject, radialSpectrum, waveField, reactiveMesh, cosmicRings, particleCloud, audioTunnel, plasmaFlow, fractalBloom]) {
  sceneRegistry.register(def);
}

export const DEFAULT_SCENE_ID = pulseObject.id;

/** v1 mode ids → scene ids */
export const LEGACY_MODE_SCENES: Record<string, string> = {
  pulse: pulseObject.id,
  radial: radialSpectrum.id,
  wave: waveField.id,
};

export function getScene(id: string): SceneDefinition {
  return sceneRegistry.get(id) ?? sceneRegistry.get(DEFAULT_SCENE_ID)!;
}
