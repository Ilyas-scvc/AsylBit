/** pulseObject — scene metadata and parameter schema (no three.js; the implementation is in ../pulseObject.ts). */
import type { SceneDefinition } from '../../types';

export const pulseObject: SceneDefinition = {
  id: 'pulse-object',
  index: '01',
  name: 'PULSE OBJECT',
  short: 'PULSE',
  description: 'Topographic noise body with a fresnel rim, particle shell and dial.',
  category: 'geometry',
  params: [
    'scale',
    { key: 'complexity', label: 'CONTOUR DENSITY' },
    'density',
    'deformation',
    'speed',
    'rotation',
    'motionIntensity',
    'direction',
    'zoom',
    'fov',
    'distance',
    'cameraRotation',
    'perspective',
    'autoOrbit',
    { key: 'gradient', default: 'blend' },
  ],
  mapping: [
    ['BASS', 'SCALE + LARGE LOBES'],
    ['KICK', 'SPRING IMPULSE + RIM'],
    ['MID', 'SURFACE FOLDING + FLOW'],
    ['HIGH', 'RIPPLE + PARTICLE SHELL'],
    ['SNARE', 'TRAVELLING RING'],
  ],
  fallback2D: 'pulse',
};
