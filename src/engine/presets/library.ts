/**
 * Pure operations on the user's preset list (no storage, easy to test). The list never
 * silently drops presets: when it is full, new ones are refused and the caller says so.
 */
import { cleanName, MAX_USER_PRESETS, newPresetId, presetFingerprint, type VisualPreset } from './schema';

export { MAX_USER_PRESETS };

export function isLibraryFull(list: readonly VisualPreset[]): boolean {
  return list.length >= MAX_USER_PRESETS;
}

/** Add (or replace by id) a preset at the top. A full library is returned unchanged. */
export function addPreset(list: VisualPreset[], preset: VisualPreset): VisualPreset[] {
  const p = { ...preset, builtIn: undefined };
  const exists = list.some((x) => x.id === p.id);
  if (!exists && isLibraryFull(list)) return list;
  return [p, ...list.filter((x) => x.id !== p.id)];
}

export interface ImportOutcome {
  list: VisualPreset[];
  added: number;
  /** identical presets that were already in the library (e.g. restoring the same backup twice) */
  duplicates: number;
  /** presets that did not fit into the library */
  overflow: number;
}

/** Add imported presets in file order on top of the library, without evicting anything. */
export function importPresets(list: VisualPreset[], incoming: VisualPreset[]): ImportOutcome {
  const known = new Set(list.map(presetFingerprint));
  const fresh: VisualPreset[] = [];
  let duplicates = 0;
  for (const p of incoming) {
    const fp = presetFingerprint(p);
    if (known.has(fp)) {
      duplicates++;
      continue;
    }
    known.add(fp);
    fresh.push({ ...p, builtIn: undefined });
  }
  const room = Math.max(0, MAX_USER_PRESETS - list.length);
  const added = fresh.slice(0, room);
  return { list: [...added, ...list], added: added.length, duplicates, overflow: fresh.length - added.length };
}

export function updatePreset(list: VisualPreset[], id: string, next: Omit<VisualPreset, 'id' | 'createdAt' | 'name'>, now = Date.now()): VisualPreset[] {
  return list.map((p) => (p.id === id ? { ...p, ...next, id, name: p.name, createdAt: p.createdAt, updatedAt: now, builtIn: undefined } : p));
}

export function renamePreset(list: VisualPreset[], id: string, name: string, now = Date.now()): VisualPreset[] {
  return list.map((p) => (p.id === id ? { ...p, name: cleanName(name, p.name), updatedAt: now } : p));
}

export function duplicatePreset(list: VisualPreset[], source: VisualPreset, now = Date.now()): { list: VisualPreset[]; copy: VisualPreset | null } {
  if (isLibraryFull(list)) return { list, copy: null };
  const copy: VisualPreset = {
    ...structuredClone(source),
    id: newPresetId(now),
    name: cleanName(`${source.name} COPY`),
    builtIn: undefined,
    createdAt: now,
    updatedAt: now,
  };
  return { list: addPreset(list, copy), copy };
}

export function removePreset(list: VisualPreset[], id: string): VisualPreset[] {
  return list.filter((p) => p.id !== id);
}
