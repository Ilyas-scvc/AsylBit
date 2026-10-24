/** fractalBloom — scene metadata and parameter schema (no three.js; the implementation is in ../fractalBloom.ts). */
import type { SceneDefinition } from '../../types';

export const fractalBloom: SceneDefinition = {
  id: 'fractal-bloom',
  index: '09',
  name: 'FRACTAL BLOOM',
  short: 'FRACTAL',
  description: 'Kaleidoscopic folded rings and petals; each fractal layer listens to its own band group.',
  category: 'experimental',
  params: [
    'scale',
    { key: 'symmetry', default: 8, min: 2 },
    { key: 'complexity', label: 'ITERATIONS', default: 0.55 },
    { key: 'deformation', label: 'AUDIO DEFORMATION' },
    { key: 'fold', label: 'FOLD OFFSET', group: 'geometry', type: 'number', min: 0, max: 0.6, step: 0.01, default: 0.1, modulatable: true },
    { key: 'petals', label: 'PETALS', group: 'geometry', type: 'number', min: 0, max: 2, step: 0.01, default: 0.6, modulatable: true },
    { key: 'glow', label: 'GLOW', group: 'geometry', type: 'number', min: 0, max: 3, step: 0.05, default: 1, modulatable: true },
    { key: 'speed', label: 'BASE SPIN' },
    { key: 'rotation', label: 'LAYER ROTATION' },
    'motionIntensity',
    'direction',
    'zoom',
    'cameraRotation',
    'autoOrbit',
    { key: 'gradient', default: 'spectrum' },
    { key: 'primary', default: '#3ad8ff' },
    { key: 'secondary', default: '#ff3ac8' },
  ],
  mapping: [
    ['LOWS', 'OUTER LAYERS'],
    ['HIGHS', 'INNER DETAIL'],
    ['KICK', 'DAMPED SWELL'],
    ['SYMMETRY', 'MIRRORED SEGMENTS'],
    ['ROTATION', 'COUNTER-ROTATING LAYERS'],
  ],
  fallback2D: 'radial',
};
