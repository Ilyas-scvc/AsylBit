/** The user's saved presets (local only). */
import { create } from 'zustand';
import { addPreset, duplicatePreset, removePreset, renamePreset, updatePreset } from '../engine/presets/library';
import { migratePreset, type VisualPreset } from '../engine/presets/schema';

const STORAGE_KEY = 'beatform.presets.v2';

function load(): VisualPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    const out: VisualPreset[] = [];
    for (const item of raw) {
      const res = migratePreset(item);
      if (res.ok) out.push({ ...res.preset, builtIn: undefined });
    }
    return out;
  } catch {
    return [];
  }
}

interface PresetStore {
  user: VisualPreset[];
  add: (p: VisualPreset) => void;
  overwrite: (id: string, p: VisualPreset) => void;
  rename: (id: string, name: string) => void;
  duplicate: (p: VisualPreset) => VisualPreset;
  remove: (id: string) => void;
  importMany: (list: VisualPreset[]) => void;
}

export const usePresets = create<PresetStore>()((set, get) => ({
  user: load(),
  add: (p) => set({ user: addPreset(get().user, p) }),
  overwrite: (id, p) => set({ user: updatePreset(get().user, id, p) }),
  rename: (id, name) => set({ user: renamePreset(get().user, id, name) }),
  duplicate: (p) => {
    const { list, copy } = duplicatePreset(get().user, p);
    set({ user: list });
    return copy;
  },
  remove: (id) => set({ user: removePreset(get().user, id) }),
  importMany: (list) => set({ user: list.reduceRight((acc, p) => addPreset(acc, p), get().user) }),
}));

if (typeof window !== 'undefined') {
  usePresets.subscribe((s) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s.user));
    } catch {
      /* storage unavailable */
    }
  });
}
