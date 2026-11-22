/**
 * The spinning disc: its settings (one global block, shared by SCENE 10 and the overlay over
 * other scenes), when it is visible and where it sits in a frame. No three.js here — the
 * Inspector, the presets and the tests use this module; the renderer is DiscLayer.ts.
 */
import { sanitizeParam, sanitizeParams } from '../params';
import type { ParamDef, ParamValues } from '../types';

/** SCENE 10 — the scene built around the disc. */
export const DISC_SCENE_ID = 'spinning-disc';

export type DiscStyle = 'classic' | 'dark' | 'holo' | 'matte' | 'neon';
export type ArtworkMode = 'full' | 'label' | 'print';
export type ArtworkFit = 'cover' | 'contain' | 'center';

export const DISC_STYLES: { value: DiscStyle; label: string }[] = [
  { value: 'classic', label: 'CLASSIC SILVER CD' },
  { value: 'dark', label: 'DARK GLOSS DISC' },
  { value: 'holo', label: 'HOLOGRAPHIC DISC' },
  { value: 'matte', label: 'MINIMAL MATTE DISC' },
  { value: 'neon', label: 'NEON REACTIVE DISC' },
];

export const DISC_GROUPS = [
  { id: 'disc', label: 'DISC SETTINGS' },
  { id: 'artwork', label: 'ARTWORK SETTINGS' },
] as const;

const num = (key: string, label: string, group: 'disc' | 'artwork', min: number, max: number, def: number, step = 0.01, extra: Partial<ParamDef> = {}): ParamDef => ({
  key,
  label,
  group,
  type: 'number',
  min,
  max,
  default: def,
  step,
  modulatable: false,
  ...extra,
});
const bool = (key: string, label: string, def: boolean, hint?: string): ParamDef => ({ key, label, group: 'disc', type: 'boolean', default: def, hint });

/** Every disc / artwork setting, in Inspector order. */
export const DISC_PARAMS: ParamDef[] = [
  bool('enabled', 'ENABLE DISC', true, 'Show / hide the disc (C)'),
  bool('overlay', 'ON ALL SCENES', false, 'Draw the disc over every scene, not only SCENE 10'),
  { key: 'style', label: 'DISC STYLE', group: 'disc', type: 'select', default: 'classic', options: DISC_STYLES },
  num('speed', 'ROTATION SPEED', 'disc', 0.05, 3, 1, 0.01, { hint: '1 = 0.4 turns per second' }),
  num('boost', 'AUDIO REACTIVE BOOST', 'disc', 0, 2, 1),
  num('size', 'DISC SIZE', 'disc', 0.3, 1.6, 1),
  num('posX', 'DISC POSITION X', 'disc', -1, 1, 0),
  num('posY', 'DISC POSITION Y', 'disc', -1, 1, 0),
  num('tiltX', 'DISC TILT X', 'disc', -60, 60, 14, 1, { unit: '°' }),
  num('tiltY', 'DISC TILT Y', 'disc', -60, 60, -10, 1, { unit: '°' }),
  num('glow', 'GLOW INTENSITY', 'disc', 0, 2, 0.6),
  num('reflection', 'REFLECTION STRENGTH', 'disc', 0, 2, 1),
  num('rim', 'RIM LIGHT', 'disc', 0, 2, 0.8),
  num('shadow', 'SHADOW STRENGTH', 'disc', 0, 1, 0.6),
  bool('jewelCase', 'SHOW JEWEL CASE', false),
  bool('centerRing', 'SHOW CENTER RING', true),
  bool('hole', 'SHOW DISC HOLE', true),
  {
    key: 'artMode',
    label: 'ARTWORK MODE',
    group: 'artwork',
    type: 'select',
    default: 'full',
    options: [
      { value: 'full', label: 'FULL DISC ART' },
      { value: 'label', label: 'CENTER LABEL ONLY' },
      { value: 'print', label: 'DISC PRINT STYLE' },
    ],
  },
  {
    key: 'artFit',
    label: 'FIT MODE',
    group: 'artwork',
    type: 'select',
    default: 'cover',
    options: [
      { value: 'cover', label: 'COVER' },
      { value: 'contain', label: 'CONTAIN' },
      { value: 'center', label: 'CENTER' },
    ],
  },
  num('artScale', 'SCALE', 'artwork', 0.25, 3, 1),
  num('artOffsetX', 'OFFSET X', 'artwork', -1, 1, 0),
  num('artOffsetY', 'OFFSET Y', 'artwork', -1, 1, 0),
  num('artRotation', 'ROTATION', 'artwork', -180, 180, 0, 1, { unit: '°' }),
  num('artBrightness', 'BRIGHTNESS', 'artwork', 0, 2, 1),
  num('artContrast', 'CONTRAST', 'artwork', 0, 2, 1),
  num('artSaturation', 'SATURATION', 'artwork', 0, 2, 1),
  num('artOpacity', 'OPACITY', 'artwork', 0, 1, 1),
];

export const DISC_PARAM_MAP = new Map(DISC_PARAMS.map((d) => [d.key, d]));

export function defaultDiscSettings(): ParamValues {
  return sanitizeParams(DISC_PARAMS, {});
}

/** Keep known keys, fill the rest with defaults, clamp everything (storage, presets, links). */
export function sanitizeDisc(raw: unknown): ParamValues {
  return sanitizeParams(DISC_PARAMS, raw);
}

export function setDiscValue(disc: ParamValues, key: string, value: unknown): ParamValues {
  const def = DISC_PARAM_MAP.get(key);
  return def ? { ...disc, [key]: sanitizeParam(def, value) } : disc;
}

/** Is the disc drawn for this scene? SCENE 10 always carries it; other scenes only as an overlay. */
export function discVisible(sceneId: string, disc: ParamValues | undefined): boolean {
  if (!disc || disc.enabled !== true) return false;
  return sceneId === DISC_SCENE_ID || disc.overlay === true;
}

/**
 * TOGGLE DISC (C): hide the disc where it is shown; where it is not, show it — on another
 * scene that means turning the overlay on.
 */
export function toggleDisc(sceneId: string, disc: ParamValues): ParamValues {
  if (discVisible(sceneId, disc)) return { ...disc, enabled: false };
  return { ...disc, enabled: true, overlay: sceneId === DISC_SCENE_ID ? disc.overlay : true };
}

/**
 * A user image for the disc: an already decoded, size-limited canvas (or bitmap). `id` changes
 * whenever the image does, so every renderer (live stage, export, preview) knows when to
 * replace its texture.
 */
export interface DiscArtwork {
  id: string;
  source: TexImageSource | OffscreenCanvas;
  width: number;
  height: number;
}

/** Jewel case outer size in disc radii (a 142 × 125 mm case around a 120 mm disc). */
export const CASE_SIZE = { width: 142 / 60, height: 125 / 60, spine: 0.11 } as const;

export interface DiscPlacement {
  /** centre, frame pixels from the top-left */
  x: number;
  y: number;
  /** disc radius in frame pixels */
  radius: number;
  portrait: boolean;
}

/**
 * Where the disc sits in a width × height frame. The composition is laid out per format, not
 * cropped: landscape frames size the disc by their height, vertical frames by their width and
 * lift it above the middle, between the stacked captions at the top and the title / player
 * (or the platform's UI) in the lower third; square frames sit in between. Position X / Y move it by up to ~40 % of the frame; with the
 * jewel case the whole case — not just the disc — is kept inside the frame.
 */
export function discPlacement(width: number, height: number, size: number, posX: number, posY: number, jewelCase: boolean): DiscPlacement {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const aspect = w / h;
  const portrait = aspect < 0.85;
  // vertical: sized and placed to sit between the stacked HUD and the title / player
  const base = portrait ? 0.32 * w : aspect < 1.25 ? 0.33 * Math.min(w, h) : 0.32 * h;
  let radius = base * size;
  // half extents of what has to stay visible (disc or case), in radii
  const ex = jewelCase ? CASE_SIZE.width / 2 : 1;
  const ey = jewelCase ? CASE_SIZE.height / 2 : 1;
  if (jewelCase) radius *= 0.78;
  // never larger than the frame
  radius = Math.min(radius, (0.48 * w) / ex, (0.48 * h) / ey);
  const cx = w / 2 + posX * 0.4 * w;
  const cy = (portrait ? 0.45 * h : 0.48 * h) - posY * 0.4 * h;
  return { x: cx, y: cy, radius, portrait };
}

/**
 * Artwork placement inside the disc square (texture units per disc unit, before offset):
 * cover fills the square (cropping the long side), contain shows the whole image inside it,
 * center keeps the image at its own pixel size relative to a 1024 px disc.
 */
export function artworkFit(fit: string, imageWidth: number, imageHeight: number): { sx: number; sy: number } {
  const iw = Math.max(1, imageWidth);
  const ih = Math.max(1, imageHeight);
  const a = iw / ih;
  if (fit === 'contain') return a >= 1 ? { sx: 1, sy: a } : { sx: 1 / a, sy: 1 };
  if (fit === 'center') return { sx: 1024 / iw, sy: 1024 / ih };
  // cover
  return a >= 1 ? { sx: 1 / a, sy: 1 } : { sx: 1, sy: a };
}
