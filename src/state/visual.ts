/**
 * Working visual state: the active scene, per-scene parameters and modulation bindings,
 * and the post-processing stack. Persisted locally (sanitised on load). A preset is a
 * snapshot of this state; loading a preset replaces it.
 */
import { create } from 'zustand';
import { createBinding, sanitizeBinding, type ModulationBinding, type ModSource } from '../engine/modulation';
import { defaultParams, getSceneSchema, sanitizeParam, sanitizeParams } from '../engine/params';
import { createEffect, EFFECT_MAP, MAX_STACK, moveEffect, sanitizeStack, type EffectInstance, type EffectType } from '../engine/post/effects';
import { BUILTIN_PRESETS } from '../engine/presets/builtins';
import { makePreset, migratePreset, presetValues, MAX_MODULATIONS, type VisualPreset } from '../engine/presets/schema';
import { DEFAULT_SCENE_ID, getScene, sceneRegistry } from '../engine/scenes/registry';
import type { ParamValue, ParamValues } from '../engine/types';

export interface SceneState {
  params: ParamValues;
  modulations: ModulationBinding[];
}

interface VisualData {
  sceneId: string;
  scenes: Record<string, SceneState>;
  post: EffectInstance[];
  presetId: string | null;
  presetName: string | null;
  dirty: boolean;
}

interface VisualActions {
  setScene: (id: string) => void;
  setParam: (key: string, value: ParamValue) => void;
  resetParam: (key: string) => void;
  resetScene: () => void;
  setBinding: (binding: ModulationBinding) => void;
  addBinding: (target: string, source?: ModSource) => void;
  removeBinding: (id: string) => void;
  addEffect: (type: EffectType) => void;
  setEffectParam: (id: string, key: string, value: ParamValue) => void;
  toggleEffect: (id: string) => void;
  moveEffect: (id: string, delta: number) => void;
  removeEffect: (id: string) => void;
  loadPreset: (preset: VisualPreset) => void;
  snapshot: (name?: string) => VisualPreset;
}

export type VisualStore = VisualData & VisualActions;

const STORAGE_KEY = 'beatform.visual.v2';
const LEGACY_KEY = 'beatform.settings.v1';

export function defaultSceneState(sceneId: string): SceneState {
  return { params: defaultParams(getSceneSchema(getScene(sceneId))), modulations: [] };
}

function sanitizeSceneState(sceneId: string, raw: unknown, post: EffectInstance[]): SceneState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  // route through the preset sanitiser so bindings are validated against real targets
  const res = migratePreset({ schema: 2, sceneId, params: r.params, modulations: r.modulations, post }, 0);
  if (!res.ok) return defaultSceneState(sceneId);
  return { params: presetValues(res.preset), modulations: res.preset.modulations };
}

export function sanitizeVisualData(raw: unknown): VisualData {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const sceneId = typeof r.sceneId === 'string' && sceneRegistry.has(r.sceneId) ? r.sceneId : DEFAULT_SCENE_ID;
  const post = sanitizeStack(r.post);
  const scenes: Record<string, SceneState> = {};
  const src = r.scenes && typeof r.scenes === 'object' ? (r.scenes as Record<string, unknown>) : {};
  for (const id of Object.keys(src)) if (sceneRegistry.has(id)) scenes[id] = sanitizeSceneState(id, src[id], post);
  if (!scenes[sceneId]) scenes[sceneId] = defaultSceneState(sceneId);
  return {
    sceneId,
    scenes,
    post,
    presetId: typeof r.presetId === 'string' ? r.presetId.slice(0, 80) : null,
    presetName: typeof r.presetName === 'string' ? r.presetName.slice(0, 60) : null,
    dirty: r.dirty === true,
  };
}

function fromPreset(p: VisualPreset): VisualData {
  return {
    sceneId: p.sceneId,
    scenes: { [p.sceneId]: { params: presetValues(p), modulations: p.modulations.map((m) => ({ ...m })) } },
    post: p.post.map((e) => ({ ...e, params: { ...e.params } })),
    presetId: p.id,
    presetName: p.name,
    dirty: false,
  };
}

function initialData(): VisualData {
  if (typeof window === 'undefined') return fromPreset(BUILTIN_PRESETS[0]);
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return sanitizeVisualData(JSON.parse(stored));
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const res = migratePreset(JSON.parse(legacy));
      if (res.ok) return { ...fromPreset(res.preset), presetId: null, presetName: 'MIGRATED FROM V1' };
    }
  } catch {
    /* corrupted storage: start fresh */
  }
  return fromPreset(BUILTIN_PRESETS[0]);
}

let effectCounter = 0;
function newEffectId(type: EffectType, existing: EffectInstance[]): string {
  let id: string;
  do {
    effectCounter++;
    id = `fx-${type}-${effectCounter.toString(36)}`;
  } while (existing.some((e) => e.id === id));
  return id;
}

export const useVisual = create<VisualStore>()((set, get) => {
  const current = (): SceneState => {
    const s = get();
    return s.scenes[s.sceneId] ?? defaultSceneState(s.sceneId);
  };
  const patchScene = (fn: (s: SceneState) => SceneState) =>
    set((s) => ({ scenes: { ...s.scenes, [s.sceneId]: fn(s.scenes[s.sceneId] ?? defaultSceneState(s.sceneId)) }, dirty: true }));

  return {
    ...initialData(),

    setScene: (id) => {
      if (!sceneRegistry.has(id) || id === get().sceneId) return;
      // the loaded preset belongs to the previous scene: never offer to overwrite it from here
      set((s) => ({ sceneId: id, scenes: s.scenes[id] ? s.scenes : { ...s.scenes, [id]: defaultSceneState(id) }, presetId: null, presetName: null, dirty: true }));
    },

    setParam: (key, value) => {
      const def = getSceneSchema(getScene(get().sceneId)).find((d) => d.key === key);
      if (!def) return;
      const v = sanitizeParam(def, value);
      patchScene((s) => ({ ...s, params: { ...s.params, [key]: v } }));
    },

    resetParam: (key) => {
      const def = getSceneSchema(getScene(get().sceneId)).find((d) => d.key === key);
      if (def) patchScene((s) => ({ ...s, params: { ...s.params, [key]: def.default } }));
    },

    resetScene: () => patchScene(() => defaultSceneState(get().sceneId)),

    setBinding: (binding) => {
      const b = sanitizeBinding(binding);
      if (!b) return;
      patchScene((s) => {
        const others = s.modulations.filter((m) => m.id !== b.id && m.target !== b.target);
        return { ...s, modulations: [...others, b].slice(-MAX_MODULATIONS) };
      });
    },

    addBinding: (target, source = 'bass') => {
      const id = `m-${target.replace(/[^\w]+/g, '-')}`;
      get().setBinding(createBinding(target, source, id));
    },

    removeBinding: (id) => patchScene((s) => ({ ...s, modulations: s.modulations.filter((m) => m.id !== id) })),

    addEffect: (type) => {
      const s = get();
      if (s.post.length >= MAX_STACK || !EFFECT_MAP.has(type)) return;
      set({ post: [...s.post, createEffect(type, newEffectId(type, s.post))], dirty: true });
    },

    setEffectParam: (id, key, value) =>
      set((s) => ({
        post: s.post.map((e) => {
          if (e.id !== id) return e;
          const def = EFFECT_MAP.get(e.type)?.params.find((d) => d.key === key);
          return def ? { ...e, params: { ...e.params, [key]: sanitizeParam(def, value) } } : e;
        }),
        dirty: true,
      })),

    toggleEffect: (id) => set((s) => ({ post: s.post.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)), dirty: true })),

    moveEffect: (id, delta) => set((s) => ({ post: moveEffect(s.post, id, delta), dirty: true })),

    removeEffect: (id) =>
      set((s) => ({
        post: s.post.filter((e) => e.id !== id),
        // drop bindings that pointed at the removed effect
        scenes: Object.fromEntries(
          Object.entries(s.scenes).map(([sid, st]) => [sid, { ...st, modulations: st.modulations.filter((m) => !m.target.startsWith(`fx:${id}:`)) }]),
        ),
        dirty: true,
      })),

    loadPreset: (preset) => set((s) => {
      const data = fromPreset(preset);
      // keep edits of other scenes; the preset's scene is replaced
      return { ...data, scenes: { ...s.scenes, ...data.scenes } };
    }),

    snapshot: (name) => {
      const s = get();
      const st = current();
      return makePreset({ sceneId: s.sceneId, values: st.params, modulations: st.modulations, post: s.post, name: name ?? s.presetName ?? 'UNTITLED' });
    },
  };
});

/**
 * Switch scenes from the UI: the first visit starts from the scene's built-in look,
 * later visits restore whatever was edited there.
 */
export function selectScene(id: string): void {
  const v = useVisual.getState();
  if (!sceneRegistry.has(id) || id === v.sceneId) return;
  if (v.scenes[id]) {
    v.setScene(id);
    return;
  }
  const preset = BUILTIN_PRESETS.find((p) => p.sceneId === id);
  if (preset) v.loadPreset(preset);
  else v.setScene(id);
}

export function stepScene(delta: number): void {
  const list = sceneRegistry.list();
  const i = list.findIndex((d) => d.id === useVisual.getState().sceneId);
  selectScene(list[(i + delta + list.length) % list.length].id);
}

/** Snapshot for the render loop (no allocation when nothing changed). */
export function visualSnapshot(s: VisualStore): { sceneId: string; params: ParamValues; modulations: ModulationBinding[]; post: EffectInstance[] } {
  const st = s.scenes[s.sceneId] ?? defaultSceneState(s.sceneId);
  return { sceneId: s.sceneId, params: st.params, modulations: st.modulations, post: s.post };
}

let saveTimer: number | undefined;
if (typeof window !== 'undefined') {
  useVisual.subscribe((s) => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        const { sceneId, scenes, post, presetId, presetName, dirty } = s;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ sceneId, scenes, post, presetId, presetName, dirty }));
      } catch {
        /* storage unavailable */
      }
    }, 300);
  });
}

/** For tests: full default state for a scene id. */
export function sceneDefaults(sceneId: string): ParamValues {
  return sanitizeParams(getSceneSchema(getScene(sceneId)), {});
}
