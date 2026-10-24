/** waveField — scene metadata and parameter schema (no three.js; the implementation is in ../waveField.ts). */
import type { SceneDefinition } from '../../types';

export const waveField: SceneDefinition = {
  id: 'wave-field',
  index: '03',
  name: 'WAVE FIELD',
  short: 'FIELD',
  description: 'Ridge lines scrolling into depth: a moving record of the last seconds of music.',
  category: 'waveforms',
  params: [
    { key: 'scale', label: 'FIELD WIDTH' },
    { key: 'density', label: 'LINE DENSITY' },
    { key: 'depth', label: 'FIELD DEPTH' },
    { key: 'deformation', label: 'RELIEF' },
    'speed',
    { key: 'rotation', label: 'DRIFT' },
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
    ['TIME', 'ROWS SCROLL AWAY'],
    ['BASS', 'BROAD SWELLS'],
    ['MID', 'BENDS THE GEOMETRY'],
    ['HIGH', 'FINE FAST RIPPLE'],
    ['CAMERA', 'SLOW DRIFT'],
  ],
  fallback2D: 'wave',
};
