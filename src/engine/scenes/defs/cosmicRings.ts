/** cosmicRings — scene metadata and parameter schema (no three.js; the implementation is in ../cosmicRings.ts). */
import type { SceneDefinition } from '../../types';

/** upper bound of the per-ring uniform arrays in the shader */
export const MAX_RINGS = 40;

export const cosmicRings: SceneDefinition = {
  id: 'cosmic-rings',
  index: '05',
  name: 'COSMIC RINGS',
  short: 'RINGS',
  description: 'Layered glowing polar rings, each tuned to its own band, folded into symmetric segments.',
  category: 'waveforms',
  params: [
    'scale',
    { key: 'rings', label: 'RINGS', group: 'geometry', type: 'number', min: 2, max: MAX_RINGS, step: 1, default: 14, modulatable: false },
    { key: 'symmetry', default: 6 },
    { key: 'deformation', label: 'SPECTRUM AMPLITUDE' },
    { key: 'complexity', label: 'PETALS', default: 0.4 },
    { key: 'depth', label: 'LAYER DEPTH', default: 0.25 },
    { key: 'lineWidth', label: 'LINE WIDTH', group: 'geometry', type: 'number', min: 0.2, max: 4, step: 0.05, default: 1, modulatable: true },
    { key: 'glow', label: 'GLOW', group: 'geometry', type: 'number', min: 0, max: 3, step: 0.05, default: 1, modulatable: true },
    { key: 'core', label: 'CORE', group: 'geometry', type: 'number', min: 0, max: 2, step: 0.05, default: 0.8, modulatable: true },
    'speed',
    { key: 'rotation', default: 1 },
    'motionIntensity',
    'direction',
    { key: 'tilt', label: 'CAMERA ANGLE', group: 'camera', type: 'number', min: 0, max: 80, step: 1, default: 0, modulatable: true, unit: '°' },
    'zoom',
    { key: 'fov', default: 40 },
    'distance',
    'cameraRotation',
    'perspective',
    'autoOrbit',
    { key: 'gradient', default: 'frequency' },
    { key: 'secondary', default: '#5b6cff' },
  ],
  mapping: [
    ['BANDS', 'ONE RING PER BAND: RADIUS + WIDTH'],
    ['KICK', 'SPRING RIPPLE, INNER → OUTER'],
    ['MIDS', 'ROSE-CURVE PETALS'],
    ['BASS', 'SHADER CORE'],
    ['SYMMETRY', 'KALEIDOSCOPIC FOLDS'],
  ],
  fallback2D: 'radial',
};
