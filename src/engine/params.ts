/**
 * Parameter catalogue and schema helpers.
 *
 * Scenes declare which parameters they support; the Inspector only ever shows those. The
 * standard catalogue gives shared parameters one meaning across scenes (Scale, Speed, Bass,
 * Zoom, Primary…); scenes may override defaults / ranges or add their own parameters.
 */
import type { ParamDef, ParamGroup, ParamReader, ParamValue, ParamValues, SceneDefinition, SceneParamSpec } from './types';

export const PARAM_GROUPS: { id: ParamGroup; label: string }[] = [
  { id: 'geometry', label: 'GEOMETRY' },
  { id: 'animation', label: 'ANIMATION' },
  { id: 'audio', label: 'AUDIO REACTION' },
  { id: 'camera', label: 'CAMERA' },
  { id: 'colors', label: 'COLORS' },
];

const num = (key: string, label: string, group: ParamGroup, min: number, max: number, def: number, step = 0.01, extra: Partial<ParamDef> = {}): ParamDef => ({
  key,
  label,
  group,
  type: 'number',
  min,
  max,
  default: def,
  step,
  modulatable: true,
  ...extra,
});

export const GRADIENT_OPTIONS = [
  { value: 'mono', label: 'MONO' },
  { value: 'blend', label: 'BLEND' },
  { value: 'frequency', label: 'FREQUENCY' },
  { value: 'spectrum', label: 'SPECTRUM' },
];

export const STANDARD_PARAMS: Record<string, ParamDef> = Object.fromEntries(
  ([
    // geometry
    num('scale', 'SCALE', 'geometry', 0.25, 2.5, 1),
    num('complexity', 'COMPLEXITY', 'geometry', 0, 1, 0.5),
    num('density', 'DENSITY', 'geometry', 0.1, 1, 0.6, 0.05, { modulatable: false, hint: 'Rebuilds geometry — not modulatable' }),
    num('deformation', 'DEFORMATION', 'geometry', 0, 2, 1),
    num('symmetry', 'SYMMETRY', 'geometry', 1, 16, 6, 1, { modulatable: false }),
    num('depth', 'DEPTH', 'geometry', 0, 2, 1),
    // animation
    num('speed', 'SPEED', 'animation', 0, 3, 1),
    num('rotation', 'ROTATION', 'animation', 0, 2, 1),
    num('motionIntensity', 'MOTION INTENSITY', 'animation', 0, 2, 1),
    num('smoothing', 'SMOOTHING', 'animation', 0, 1, 0.45, 0.01, { modulatable: false }),
    num('decay', 'DECAY', 'animation', 0.25, 3, 1, 0.05, { modulatable: false }),
    {
      key: 'direction',
      label: 'MOTION DIRECTION',
      group: 'animation',
      type: 'select',
      default: 'forward',
      options: [
        { value: 'forward', label: 'FORWARD' },
        { value: 'reverse', label: 'REVERSE' },
      ],
    },
    // audio reaction
    num('bass', 'BASS', 'audio', 0, 2.5, 1, 0.05),
    num('mids', 'MIDS', 'audio', 0, 2.5, 1, 0.05),
    num('treble', 'TREBLE', 'audio', 0, 2.5, 1, 0.05),
    num('subBass', 'SUB BASS', 'audio', 0, 2.5, 1, 0.05),
    num('kickImpact', 'KICK IMPACT', 'audio', 0, 2, 1, 0.05),
    num('snareImpact', 'SNARE IMPACT', 'audio', 0, 2, 1, 0.05),
    num('transientSensitivity', 'TRANSIENT SENSITIVITY', 'audio', 0, 2, 1, 0.05),
    num('noiseGate', 'NOISE GATE', 'audio', 0, 1, 0.1, 0.01),
    // camera
    num('zoom', 'ZOOM', 'camera', 0.4, 3, 1),
    num('fov', 'FIELD OF VIEW', 'camera', 15, 110, 35, 1, { unit: '°' }),
    num('distance', 'CAMERA DISTANCE', 'camera', 0.5, 2.5, 1),
    num('cameraRotation', 'ROTATION', 'camera', -180, 180, 0, 1, { unit: '°' }),
    num('perspective', 'PERSPECTIVE', 'camera', 0, 1, 1),
    num('autoOrbit', 'AUTO ORBIT', 'camera', -40, 40, 0, 0.5, { unit: '°/S' }),
    // colors
    { key: 'primary', label: 'PRIMARY', group: 'colors', type: 'color', default: '#d4ff3a' },
    { key: 'secondary', label: 'SECONDARY', group: 'colors', type: 'color', default: '#ecece6' },
    { key: 'background', label: 'BACKGROUND', group: 'colors', type: 'color', default: '#050505' },
    { key: 'gradient', label: 'GRADIENT', group: 'colors', type: 'select', default: 'blend', options: GRADIENT_OPTIONS },
    num('brightness', 'BRIGHTNESS', 'colors', 0, 2, 1),
    num('contrast', 'CONTRAST', 'colors', 0, 2, 1),
    num('saturation', 'SATURATION', 'colors', 0, 2, 1),
  ] as ParamDef[]).map((d) => [d.key, d]),
);

/** Parameters every scene supports (analysis tuning + palette + grade). */
export const COMMON_PARAMS: SceneParamSpec[] = [
  'smoothing',
  'decay',
  'bass',
  'mids',
  'treble',
  'subBass',
  'kickImpact',
  'snareImpact',
  'transientSensitivity',
  'noiseGate',
  'primary',
  'secondary',
  'background',
  'gradient',
  'brightness',
  'contrast',
  'saturation',
];

const schemaCache = new WeakMap<SceneDefinition, ParamDef[]>();

export function resolveSpec(spec: SceneParamSpec): ParamDef {
  if (typeof spec === 'string') {
    const std = STANDARD_PARAMS[spec];
    if (!std) throw new Error(`Unknown standard parameter "${spec}"`);
    return std;
  }
  const std = STANDARD_PARAMS[spec.key];
  if (std) return { ...std, ...spec } as ParamDef;
  if (!spec.label || !spec.group || !spec.type || spec.default === undefined) {
    throw new Error(`Custom parameter "${spec.key}" needs label, group, type and default`);
  }
  return { modulatable: spec.type === 'number', ...spec } as ParamDef;
}

/** Throws when a resolved parameter is internally inconsistent (bad range / default / options). */
function validateDef(d: ParamDef): void {
  const fail = (why: string) => {
    throw new Error(`Parameter "${d.key}": ${why}`);
  };
  if (d.type === 'number') {
    if (typeof d.default !== 'number' || d.min === undefined || d.max === undefined || !(d.min < d.max)) fail('needs a numeric default and min < max');
    if ((d.default as number) < d.min! || (d.default as number) > d.max!) fail('default is outside its range');
  } else if (d.type === 'select') {
    if (!d.options?.length || !d.options.some((o) => o.value === d.default)) fail('default is not one of its options');
  } else if (d.type === 'color') {
    if (typeof d.default !== 'string' || !/^#[0-9a-f]{6}$/i.test(d.default)) fail('default is not a #rrggbb colour');
  } else if (d.type === 'boolean' && typeof d.default !== 'boolean') fail('default is not a boolean');
}

/** Full, de-duplicated parameter schema of a scene (scene-specific specs win). */
export function getSceneSchema(def: SceneDefinition): ParamDef[] {
  const cached = schemaCache.get(def);
  if (cached) return cached;
  const map = new Map<string, ParamDef>();
  for (const spec of COMMON_PARAMS) {
    const d = resolveSpec(spec);
    map.set(d.key, d);
  }
  for (const spec of def.params) {
    const d = resolveSpec(spec);
    validateDef(d);
    map.set(d.key, d);
  }
  const order = new Map(PARAM_GROUPS.map((g, i) => [g.id, i]));
  const list = [...map.values()].sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0));
  schemaCache.set(def, list);
  return list;
}

export function schemaMap(schema: ParamDef[]): Map<string, ParamDef> {
  return new Map(schema.map((d) => [d.key, d]));
}

export function defaultParams(schema: ParamDef[]): ParamValues {
  const out: ParamValues = {};
  for (const d of schema) out[d.key] = d.default;
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Coerce one value into a parameter's type and range; returns the default when invalid. */
export function sanitizeParam(def: ParamDef, value: unknown): ParamValue {
  switch (def.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (!Number.isFinite(n)) return def.default;
      let v = Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, n));
      if (def.step && def.step >= 1) v = Math.round(v);
      return v;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : def.default;
    case 'select':
      return typeof value === 'string' && def.options?.some((o) => o.value === value) ? value : def.default;
    case 'color':
      return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : def.default;
  }
}

/** Keep only known keys, fill missing ones with defaults, clamp everything. */
export function sanitizeParams(schema: ParamDef[], raw: unknown): ParamValues {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: ParamValues = {};
  for (const d of schema) out[d.key] = d.key in src ? sanitizeParam(d, src[d.key]) : d.default;
  return out;
}

/** Allocation-free reader over a resolved parameter object. */
export class ValuesReader implements ParamReader {
  values: ParamValues = {};
  num(key: string): number {
    const v = this.values[key];
    return typeof v === 'number' ? v : 0;
  }
  bool(key: string): boolean {
    return this.values[key] === true;
  }
  str(key: string): string {
    const v = this.values[key];
    return typeof v === 'string' ? v : '';
  }
  has(key: string): boolean {
    return key in this.values;
  }
}

export function formatParam(def: ParamDef, v: ParamValue): string {
  if (def.type !== 'number' || typeof v !== 'number') return String(v).toUpperCase();
  const step = def.step ?? 0.01;
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `${v.toFixed(digits)}${def.unit ?? ''}`;
}
