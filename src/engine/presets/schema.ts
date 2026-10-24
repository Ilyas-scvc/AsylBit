/**
 * Preset format (schema v2), migration and safe (de)serialisation.
 *
 * A preset is a complete look: scene id, scene parameters, colours, camera, modulation
 * bindings and the post-processing stack. Everything that comes from outside (storage,
 * imported JSON, share links) goes through `migratePreset`, which upgrades older schemas,
 * rejects newer ones and clamps every value — a tampered preset can never put the engine
 * into an invalid state.
 */
import { createBinding, sanitizeBinding, type ModulationBinding } from '../modulation';
import { getSceneSchema, sanitizeParams } from '../params';
import { EFFECT_MAP, sanitizeStack, type EffectInstance } from '../post/effects';
import { DEFAULT_SCENE_ID, LEGACY_MODE_SCENES, getScene, sceneRegistry } from '../scenes/registry';
import type { ParamValues } from '../types';

export const PRESET_SCHEMA = 2;
export const MAX_MODULATIONS = 32;
export const MAX_NAME = 60;
/** Upper bound for an encoded share link payload (characters). */
export const MAX_URL_PAYLOAD = 6000;
/** Size of the user's preset library. */
export const MAX_USER_PRESETS = 200;
/**
 * Upper bound for an imported JSON file (bytes), checked before the file is read. A backup of
 * a full library of the largest presets the schema allows (32 modulations, 12 effects each)
 * is ≈ 3.8 MB, so EXPORT ALL always restores in one file.
 */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
/** One file may hold a whole library. */
export const MAX_IMPORT_PRESETS = MAX_USER_PRESETS;

export interface VisualPreset {
  schema: typeof PRESET_SCHEMA;
  id: string;
  name: string;
  builtIn?: boolean;
  createdAt: number;
  updatedAt: number;
  sceneId: string;
  /** geometry / animation / audio-reaction parameters */
  params: ParamValues;
  colors: ParamValues;
  camera: ParamValues;
  modulations: ModulationBinding[];
  post: EffectInstance[];
}

export type MigrationResult = { ok: true; preset: VisualPreset; migratedFrom: number } | { ok: false; error: string };

let idCounter = 0;
export function newPresetId(now = Date.now()): string {
  idCounter = (idCounter + 1) % 1e6;
  return `p-${now.toString(36)}-${idCounter.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function cleanName(name: unknown, fallback = 'UNTITLED'): string {
  if (typeof name !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_NAME);
  return s || fallback;
}

/** Split a flat parameter object into the preset's sections (by parameter group). */
export function splitParams(sceneId: string, values: ParamValues): Pick<VisualPreset, 'params' | 'colors' | 'camera'> {
  const out = { params: {} as ParamValues, colors: {} as ParamValues, camera: {} as ParamValues };
  for (const d of getSceneSchema(getScene(sceneId))) {
    if (!(d.key in values)) continue;
    const bucket = d.group === 'colors' ? out.colors : d.group === 'camera' ? out.camera : out.params;
    bucket[d.key] = values[d.key];
  }
  return out;
}

/** Flat, sanitised parameter object of a preset for its scene. */
export function presetValues(p: Pick<VisualPreset, 'sceneId' | 'params' | 'colors' | 'camera'>): ParamValues {
  return sanitizeParams(getSceneSchema(getScene(p.sceneId)), { ...p.params, ...p.colors, ...p.camera });
}

export function makePreset(input: {
  sceneId: string;
  values: ParamValues;
  modulations?: ModulationBinding[];
  post?: EffectInstance[];
  name?: string;
  id?: string;
  builtIn?: boolean;
  now?: number;
}): VisualPreset {
  const now = input.now ?? Date.now();
  const sceneId = sceneRegistry.has(input.sceneId) ? input.sceneId : DEFAULT_SCENE_ID;
  return {
    schema: PRESET_SCHEMA,
    id: input.id ?? newPresetId(now),
    name: cleanName(input.name),
    builtIn: input.builtIn || undefined,
    createdAt: now,
    updatedAt: now,
    sceneId,
    ...splitParams(sceneId, sanitizeParams(getSceneSchema(getScene(sceneId)), input.values)),
    modulations: (input.modulations ?? []).slice(0, MAX_MODULATIONS),
    post: input.post ?? [],
  };
}

function validTargets(sceneId: string, post: EffectInstance[]): Set<string> {
  const set = new Set<string>();
  for (const d of getSceneSchema(getScene(sceneId))) if (d.type === 'number' && d.modulatable !== false) set.add(d.key);
  for (const e of post) {
    for (const d of EFFECT_MAP.get(e.type)?.params ?? []) if (d.type === 'number' && d.modulatable !== false) set.add(`fx:${e.id}:${d.key}`);
  }
  return set;
}

function sanitizeV2(r: Record<string, unknown>, now: number): VisualPreset {
  const sceneId = typeof r.sceneId === 'string' && sceneRegistry.has(r.sceneId) ? r.sceneId : DEFAULT_SCENE_ID;
  const section = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const values = sanitizeParams(getSceneSchema(getScene(sceneId)), { ...section(r.params), ...section(r.colors), ...section(r.camera) });
  const post = sanitizeStack(r.post);
  const targets = validTargets(sceneId, post);
  const modulations: ModulationBinding[] = [];
  const ids = new Set<string>();
  if (Array.isArray(r.modulations)) {
    for (const m of r.modulations) {
      const b = sanitizeBinding(m);
      if (!b || !targets.has(b.target) || ids.has(b.id)) continue;
      ids.add(b.id);
      modulations.push(b);
      if (modulations.length >= MAX_MODULATIONS) break;
    }
  }
  const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : now);
  return {
    schema: PRESET_SCHEMA,
    id: typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id) ? r.id : newPresetId(now),
    name: cleanName(r.name),
    builtIn: r.builtIn === true || undefined,
    createdAt: time(r.createdAt),
    updatedAt: time(r.updatedAt),
    sceneId,
    ...splitParams(sceneId, values),
    modulations,
    post,
  };
}

/** v1 = the BEAT//FORM 1.0 settings object (mode, accent, sensitivities …). */
function fromV1(r: Record<string, unknown>, now: number): VisualPreset {
  const sceneId = LEGACY_MODE_SCENES[String(r.mode)] ?? DEFAULT_SCENE_ID;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : undefined);
  const values: Record<string, unknown> = {
    primary: r.accent,
    background: r.background,
    bass: n('bassSensitivity'),
    subBass: n('bassSensitivity'),
    mids: n('midSensitivity'),
    treble: n('highSensitivity'),
    kickImpact: n('beatImpact'),
    snareImpact: n('beatImpact'),
    smoothing: n('smoothing'),
    density: n('particleDensity'),
    rotation: n('rotationSpeed'),
    motionIntensity: n('intensity'),
  };
  for (const k of Object.keys(values)) if (values[k] === undefined) delete values[k];
  return sanitizeV2({ sceneId, name: typeof r.name === 'string' ? r.name : 'MIGRATED V1 SETTINGS', params: values }, now);
}

export function migratePreset(raw: unknown, now = Date.now()): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'NOT A PRESET OBJECT' };
  const r = raw as Record<string, unknown>;
  const schema = r.schema;
  if (schema === undefined || schema === 1) {
    if ('mode' in r || 'accent' in r || 'beatImpact' in r || 'bassSensitivity' in r) return { ok: true, preset: fromV1(r, now), migratedFrom: 1 };
    return { ok: false, error: 'UNKNOWN PRESET FORMAT' };
  }
  if (typeof schema !== 'number' || !Number.isInteger(schema)) return { ok: false, error: 'INVALID SCHEMA VERSION' };
  if (schema > PRESET_SCHEMA) return { ok: false, error: `PRESET IS FROM A NEWER VERSION (SCHEMA ${schema})` };
  return { ok: true, preset: sanitizeV2(r, now), migratedFrom: schema };
}

// ---- JSON --------------------------------------------------------------------------------

export function presetToJson(presets: VisualPreset | VisualPreset[]): string {
  const list = Array.isArray(presets) ? presets : [presets];
  const strip = (p: VisualPreset) => ({ ...p, builtIn: undefined });
  return JSON.stringify({ format: 'beatform-preset', schema: PRESET_SCHEMA, presets: list.map(strip) }, null, 2);
}

const TOO_LARGE = `FILE TOO LARGE (MAX ${MAX_IMPORT_BYTES / 2 ** 20} MB)`;

export function presetsFromJson(text: string, now = Date.now()): { presets: VisualPreset[]; errors: string[] } {
  if (text.length > MAX_IMPORT_BYTES) return { presets: [], errors: [TOO_LARGE] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { presets: [], errors: ['NOT VALID JSON'] };
  }
  const items: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { presets?: unknown }).presets)
      ? ((data as { presets: unknown[] }).presets)
      : [data];
  const presets: VisualPreset[] = [];
  const errors: string[] = [];
  for (const item of items.slice(0, MAX_IMPORT_PRESETS)) {
    const res = migratePreset(item, now);
    if (res.ok) presets.push({ ...res.preset, builtIn: undefined, id: newPresetId(now) });
    else errors.push(res.error);
  }
  if (items.length > MAX_IMPORT_PRESETS) errors.push(`ONLY THE FIRST ${MAX_IMPORT_PRESETS} PRESETS WERE IMPORTED`);
  return { presets, errors };
}

/** Import from a user-picked file: the size is checked before anything is read into memory. */
export async function presetsFromFile(file: Pick<Blob, 'size' | 'text'>, now = Date.now()): Promise<{ presets: VisualPreset[]; errors: string[] }> {
  if (file.size > MAX_IMPORT_BYTES) return { presets: [], errors: [TOO_LARGE] };
  return presetsFromJson(await file.text(), now);
}

/**
 * EXPORT ALL as one file — or, should a library ever outgrow the import limit, as several
 * files that each import on their own.
 */
export function presetBackupFiles(presets: VisualPreset[], limitBytes = MAX_IMPORT_BYTES): string[] {
  const whole = presetToJson(presets);
  if (whole.length <= limitBytes || presets.length <= 1) return [whole];
  const half = Math.ceil(presets.length / 2);
  return [...presetBackupFiles(presets.slice(0, half), limitBytes), ...presetBackupFiles(presets.slice(half), limitBytes)];
}

/** Content of a preset without its identity, to recognise one that is already in a library. */
export function presetFingerprint(p: VisualPreset): string {
  return JSON.stringify([p.name, p.sceneId, presetValues(p), p.modulations, p.post]);
}

// ---- share links ---------------------------------------------------------------------------

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Compact share payload: only values that differ from the scene defaults. Never contains audio. */
export function encodePresetForUrl(p: VisualPreset): string {
  const defaults = Object.fromEntries(getSceneSchema(getScene(p.sceneId)).map((d) => [d.key, d.default]));
  const diff = (section: ParamValues) => Object.fromEntries(Object.entries(section).filter(([k, v]) => defaults[k] !== v));
  const payload = {
    schema: PRESET_SCHEMA,
    name: p.name,
    sceneId: p.sceneId,
    params: diff(p.params),
    colors: diff(p.colors),
    camera: diff(p.camera),
    modulations: p.modulations,
    post: p.post,
  };
  const encoded = toBase64Url(JSON.stringify(payload));
  if (encoded.length > MAX_URL_PAYLOAD) throw new Error('PRESET TOO LARGE FOR A LINK — EXPORT JSON INSTEAD');
  return encoded;
}

export function decodePresetFromUrl(encoded: string, now = Date.now()): MigrationResult {
  if (!encoded || encoded.length > MAX_URL_PAYLOAD) return { ok: false, error: 'LINK IS EMPTY OR TOO LONG' };
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, error: 'LINK IS MALFORMED' };
  let data: unknown;
  try {
    data = JSON.parse(fromBase64Url(encoded));
  } catch {
    return { ok: false, error: 'LINK IS MALFORMED' };
  }
  const res = migratePreset(data, now);
  if (res.ok) res.preset = { ...res.preset, builtIn: undefined, id: newPresetId(now) };
  return res;
}

export const SHARE_HASH_KEY = 'preset';

/** Example binding used by the "BASS ZOOM" built-in preset and docs. */
export function exampleZoomBinding(): ModulationBinding {
  return { ...createBinding('zoom', 'bass', 'm-zoom-bass'), amount: 0.25, attack: 0.04, release: 0.35 };
}
