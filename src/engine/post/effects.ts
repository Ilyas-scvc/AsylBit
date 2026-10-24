/** Post-processing effect catalogue and stack helpers (pure data, no WebGL). */
import { sanitizeParams } from '../params';
import type { ParamDef, ParamValues } from '../types';

export type EffectType = 'bloom' | 'chromatic' | 'grain' | 'vignette' | 'kaleidoscope' | 'pixelate' | 'glitch' | 'trails';

export interface EffectDefinition {
  type: EffectType;
  name: string;
  description: string;
  /** rough relative GPU cost, used by the quality budget */
  cost: number;
  /** true if the order of this effect relative to others visibly matters */
  orderSensitive: boolean;
  params: ParamDef[];
}

export interface EffectInstance {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: ParamValues;
}

const p = (key: string, label: string, min: number, max: number, def: number, step = 0.01, extra: Partial<ParamDef> = {}): ParamDef => ({
  key,
  label,
  group: 'geometry',
  type: 'number',
  min,
  max,
  default: def,
  step,
  modulatable: true,
  ...extra,
});

export const EFFECTS: EffectDefinition[] = [
  {
    type: 'bloom',
    name: 'BLOOM',
    description: 'Glow around bright areas (dual-filter blur, half resolution)',
    cost: 3,
    orderSensitive: true,
    params: [p('threshold', 'THRESHOLD', 0, 1, 0.55), p('intensity', 'INTENSITY', 0, 3, 1.1), p('radius', 'RADIUS', 0, 1, 0.65)],
  },
  {
    type: 'trails',
    name: 'MOTION TRAILS',
    description: 'Feedback echo of previous frames with zoom / rotation',
    cost: 1,
    orderSensitive: true,
    params: [
      p('persistence', 'PERSISTENCE', 0, 0.97, 0.78),
      p('zoom', 'ZOOM', -0.03, 0.03, 0.006, 0.001),
      p('rotate', 'ROTATE', -45, 45, 0, 0.5, { unit: '°/S' }),
      {
        key: 'blend',
        label: 'BLEND',
        group: 'geometry',
        type: 'select',
        default: 'lighten',
        options: [
          { value: 'lighten', label: 'LIGHTEN' },
          { value: 'add', label: 'ADD' },
        ],
      },
    ],
  },
  {
    type: 'kaleidoscope',
    name: 'KALEIDOSCOPE',
    description: 'Mirrors the image into radial segments',
    cost: 1,
    orderSensitive: true,
    params: [
      p('segments', 'SEGMENTS', 2, 16, 6, 1, { modulatable: false }),
      p('rotation', 'ROTATION', -180, 180, 0, 1, { unit: '°' }),
      p('spin', 'SPIN', -60, 60, 4, 0.5, { unit: '°/S' }),
      p('zoom', 'ZOOM', 0.4, 2.5, 1),
    ],
  },
  {
    type: 'chromatic',
    name: 'CHROMATIC ABERRATION',
    description: 'Radial colour fringing toward the edges',
    cost: 1,
    orderSensitive: false,
    params: [p('amount', 'AMOUNT', 0, 1, 0.25)],
  },
  {
    type: 'pixelate',
    name: 'PIXELATE',
    description: 'Square pixel blocks',
    cost: 1,
    orderSensitive: true,
    params: [p('size', 'BLOCK SIZE', 2, 48, 6, 1, { unit: 'PX' })],
  },
  {
    type: 'glitch',
    name: 'GLITCH',
    description: 'Deterministic block displacement, optionally kicked by transients',
    cost: 1,
    orderSensitive: true,
    params: [
      p('amount', 'AMOUNT', 0, 1, 0.25),
      p('speed', 'SPEED', 0, 3, 0.8),
      p('blockSize', 'BLOCK SIZE', 4, 64, 22, 1, { unit: 'PX' }),
      p('audio', 'KICK DRIVE', 0, 1, 0.5),
    ],
  },
  {
    type: 'grain',
    name: 'FILM GRAIN',
    description: 'Fine animated grain (seeded by time, reproducible in exports)',
    cost: 1,
    orderSensitive: false,
    params: [p('amount', 'AMOUNT', 0, 1, 0.12), p('size', 'SIZE', 1, 4, 1.4, 0.1)],
  },
  {
    type: 'vignette',
    name: 'VIGNETTE',
    description: 'Darkens the frame edges',
    cost: 1,
    orderSensitive: false,
    params: [p('amount', 'AMOUNT', 0, 1, 0.45), p('softness', 'SOFTNESS', 0.05, 1, 0.55)],
  },
];

export const EFFECT_MAP = new Map(EFFECTS.map((e) => [e.type, e]));

export function createEffect(type: EffectType, id: string): EffectInstance {
  const def = EFFECT_MAP.get(type)!;
  return { id, type, enabled: true, params: sanitizeParams(def.params, {}) };
}

export const MAX_STACK = 12;

export function sanitizeEffect(raw: unknown): EffectInstance | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const def = typeof r.type === 'string' ? EFFECT_MAP.get(r.type as EffectType) : undefined;
  if (!def) return null;
  const id = typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : `${def.type}-${Math.abs(hashString(JSON.stringify(r))).toString(36)}`;
  return { id, type: def.type, enabled: r.enabled !== false, params: sanitizeParams(def.params, r.params) };
}

export function sanitizeStack(raw: unknown): EffectInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: EffectInstance[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_STACK)) {
    const e = sanitizeEffect(item);
    if (!e) continue;
    while (ids.has(e.id)) e.id = `${e.id}x`;
    ids.add(e.id);
    out.push(e);
  }
  return out;
}

export function moveEffect(stack: EffectInstance[], id: string, delta: number): EffectInstance[] {
  const i = stack.findIndex((e) => e.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= stack.length) return stack;
  const out = stack.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Which effects actually render under a quality budget (the rest are skipped, in order). */
export function budgetedEffects(stack: EffectInstance[], maxEffects: number): EffectInstance[] {
  return stack.filter((e) => e.enabled).slice(0, maxEffects);
}

/** Modulation target key for an effect parameter. */
export function fxTarget(effectId: string, param: string): string {
  return `fx:${effectId}:${param}`;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}
