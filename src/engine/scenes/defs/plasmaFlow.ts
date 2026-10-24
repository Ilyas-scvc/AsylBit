/** plasmaFlow — scene metadata and parameter schema (no three.js; the implementation is in ../plasmaFlow.ts). */
import type { SceneDefinition } from '../../types';

export const plasmaFlow: SceneDefinition = {
  id: 'plasma-flow',
  index: '08',
  name: 'PLASMA FLOW',
  short: 'PLASMA',
  description: 'Domain-warped liquid light with flowing trails; the spectrum steers colour and warp.',
  category: 'abstract',
  params: [
    { key: 'scale', label: 'FIELD SCALE' },
    { key: 'complexity', label: 'DETAIL (OCTAVES)', default: 0.5 },
    { key: 'deformation', label: 'WARP', default: 1 },
    { key: 'trails', label: 'LIGHT TRAILS', group: 'geometry', type: 'number', min: 0, max: 2, step: 0.01, default: 0.8, modulatable: true },
    { key: 'trailDensity', label: 'TRAIL DENSITY', group: 'geometry', type: 'number', min: 0, max: 1, step: 0.01, default: 0.4, modulatable: true },
    { key: 'speed', label: 'FLOW SPEED' },
    { key: 'rotation', default: 0.5 },
    'motionIntensity',
    'direction',
    'zoom',
    'cameraRotation',
    'autoOrbit',
    { key: 'gradient', default: 'blend' },
    { key: 'primary', default: '#ff5b2e' },
    { key: 'secondary', default: '#6a2cff' },
    { key: 'background', default: '#040308' },
  ],
  mapping: [
    ['BASS', 'WARP + BRIGHTNESS'],
    ['MIDS', 'DETAIL WARP + COLOUR'],
    ['TREBLE', 'LIGHT TRAILS'],
    ['KICK', 'BOUNDED SWELL'],
    ['TIME', 'LIQUID FLOW'],
  ],
  fallback2D: 'pulse',
};
