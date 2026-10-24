/** Pure operations on the user's preset list (no storage, easy to test). */
import { cleanName, newPresetId, type VisualPreset } from './schema';

export const MAX_USER_PRESETS = 200;

export function addPreset(list: VisualPreset[], preset: VisualPreset): VisualPreset[] {
  const p = { ...preset, builtIn: undefined };
  return [p, ...list.filter((x) => x.id !== p.id)].slice(0, MAX_USER_PRESETS);
}

export function updatePreset(list: VisualPreset[], id: string, next: Omit<VisualPreset, 'id' | 'createdAt' | 'name'>, now = Date.now()): VisualPreset[] {
  return list.map((p) => (p.id === id ? { ...p, ...next, id, name: p.name, createdAt: p.createdAt, updatedAt: now, builtIn: undefined } : p));
}

export function renamePreset(list: VisualPreset[], id: string, name: string, now = Date.now()): VisualPreset[] {
  return list.map((p) => (p.id === id ? { ...p, name: cleanName(name, p.name), updatedAt: now } : p));
}

export function duplicatePreset(list: VisualPreset[], source: VisualPreset, now = Date.now()): { list: VisualPreset[]; copy: VisualPreset } {
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
