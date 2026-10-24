/** radialSpectrum — scene metadata and parameter schema (no three.js; the implementation is in ../radialSpectrum.ts). */
import type { SceneDefinition } from '../../types';

export const radialSpectrum: SceneDefinition = {
  id: 'radial-spectrum',
  index: '02',
  name: 'RADIAL SPECTRUM',
  short: 'RADIAL',
  description: '192 log-spaced wedge bars with a receding spectral tunnel and oscilloscope ring.',
  category: 'waveforms',
  params: [
    'scale',
    'density',
    { key: 'depth', label: 'TUNNEL DEPTH' },
    { key: 'speed', label: 'HISTORY SPEED' },
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
    ['FFT', '192 LOG-SPACED LINES'],
    ['LOWS', 'LONG, SLOW, HEAVY'],
    ['HIGHS', 'SHORT, FAST, LIGHT'],
    ['HISTORY', 'RECEDING TUNNEL'],
    ['HAT', 'PARTICLES FROM ITS BAND'],
  ],
  fallback2D: 'radial',
};
