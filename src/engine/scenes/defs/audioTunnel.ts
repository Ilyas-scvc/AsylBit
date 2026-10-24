/** audioTunnel — scene metadata and parameter schema (no three.js; the implementation is in ../audioTunnel.ts). */
import type { SceneDefinition } from '../../types';

export const audioTunnel: SceneDefinition = {
  id: 'audio-tunnel',
  index: '07',
  name: 'INFINITE AUDIO TUNNEL',
  short: 'TUNNEL',
  description: 'An endless tunnel of glowing rings and spokes; bass and kicks push the flight forward.',
  category: 'geometry',
  params: [
    { key: 'scale', label: 'TUNNEL RADIUS' },
    { key: 'symmetry', label: 'SIDES · 16 = ROUND', default: 8, min: 3, max: 16 },
    { key: 'density', label: 'RING COUNT' },
    { key: 'depth', label: 'RING SPACING' },
    { key: 'deformation', label: 'DISTORTION', default: 0.6 },
    { key: 'complexity', label: 'TWIST', default: 0.3 },
    { key: 'speed', label: 'FLIGHT SPEED' },
    { key: 'rotation', label: 'SPIN', default: 0.6 },
    'motionIntensity',
    'direction',
    { key: 'zoom' },
    { key: 'fov', default: 72 },
    { key: 'cameraRotation', label: 'ROLL' },
    { key: 'autoOrbit', label: 'AUTO ROLL' },
    { key: 'gradient', default: 'frequency' },
    { key: 'secondary', default: '#2f6bff' },
  ],
  mapping: [
    ['BASS + KICK', 'FLIGHT THRUST (SPRING)'],
    ['PULSES', 'TRAVEL INTO THE DEPTH'],
    ['SPECTRUM', 'RING OUTLINES'],
    ['SYMMETRY', 'POLYGON + SPOKES'],
    ['DISTORTION', 'BENDING AXIS'],
  ],
  fallback2D: 'radial',
};
