/** spinningDisc — scene metadata and parameter schema (no three.js; the implementation is in ../spinningDisc.ts). */
import type { SceneDefinition } from '../../types';
import { DISC_SCENE_ID } from '../../disc/settings';

export const spinningDisc: SceneDefinition = {
  id: DISC_SCENE_ID,
  index: '10',
  name: 'SPINNING DISC',
  short: 'DISC',
  description: 'A compact disc spinning in a dark studio — your artwork on it, light gliding over the surface, the rim catching every kick.',
  category: 'geometry',
  params: [
    { key: 'speed', label: 'DUST DRIFT', default: 1 },
    { key: 'dust', label: 'DUST', group: 'geometry', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, modulatable: true },
    { key: 'haze', label: 'HAZE', group: 'geometry', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, modulatable: true },
    { key: 'falloff', label: 'EDGE FALLOFF', group: 'geometry', type: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
    'motionIntensity',
    { key: 'gradient', default: 'blend' },
    { key: 'primary', default: '#8fd3ff' },
    { key: 'secondary', default: '#ff7ad9' },
    { key: 'background', default: '#050507' },
  ],
  mapping: [
    ['BASS', 'DISC SCALE PULSE'],
    ['KICK', 'RIM GLOW FLASH'],
    ['MIDS', 'REFLECTIONS'],
    ['TREBLE', 'SPARKLES + DUST'],
    ['TIME', 'STEADY SPIN'],
  ],
  fallback2D: 'radial',
};
