/** The user's saved presets (local only). */
import { create } from 'zustand';
import { addPreset, duplicatePreset, importPresets, isLibraryFull, removePreset, renamePreset, updatePreset, type ImportOutcome } from '../engine/presets/library';
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
  /** false when the library is full (nothing is ever pushed out) */
  add: (p: VisualPreset) => boolean;
  overwrite: (id: string, p: VisualPreset) => void;
  rename: (id: string, name: string) => void;
  /** null when the library is full */
  duplicate: (p: VisualPreset) => VisualPreset | null;
  remove: (id: string) => void;
  importMany: (list: VisualPreset[]) => Omit<ImportOutcome, 'list'>;
}

export const usePresets = create<PresetStore>()((set, get) => ({
  user: load(),
  add: (p) => {
    const list = get().user;
    if (isLibraryFull(list) && !list.some((x) => x.id === p.id)) return false;
    set({ user: addPreset(list, p) });
    return true;
  },
  overwrite: (id, p) => set({ user: updatePreset(get().user, id, p) }),
  rename: (id, name) => set({ user: renamePreset(get().user, id, name) }),
  duplicate: (p) => {
    const { list, copy } = duplicatePreset(get().user, p);
    set({ user: list });
    return copy;
  },
  remove: (id) => set({ user: removePreset(get().user, id) }),
  importMany: (incoming) => {
    const { list, ...outcome } = importPresets(get().user, incoming);
    set({ user: list });
    return outcome;
  },
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
