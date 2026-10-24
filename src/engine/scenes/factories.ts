/**
 * Scene id → factory. Imported only by the VisualizerEngine, which itself is only reached
 * through lazy chunks (live WebGL stage, video renderer, thumbnails).
 */
import type { SceneFactory } from '../types';
import { create as audioTunnel } from './audioTunnel';
import { create as cosmicRings } from './cosmicRings';
import { create as fractalBloom } from './fractalBloom';
import { create as particleCloud } from './particleCloud';
import { create as plasmaFlow } from './plasmaFlow';
import { create as pulseObject } from './pulseObject';
import { create as radialSpectrum } from './radialSpectrum';
import { create as reactiveMesh } from './reactiveMesh';
import { create as waveField } from './waveField';

export const SCENE_FACTORIES: Readonly<Record<string, SceneFactory>> = {
  'pulse-object': pulseObject,
  'radial-spectrum': radialSpectrum,
  'wave-field': waveField,
  'reactive-mesh': reactiveMesh,
  'cosmic-rings': cosmicRings,
  'particle-cloud': particleCloud,
  'audio-tunnel': audioTunnel,
  'plasma-flow': plasmaFlow,
  'fractal-bloom': fractalBloom,
};
