/**
 * UI state: immersive (hidden-UI) mode, panels and the preview frame.
 * Hiding the UI is purely presentational — it never touches playback or the WebGL context.
 */
import { create } from 'zustand';

export type InspectorTab = 'scene' | 'fx' | 'presets' | 'system';
export type PreviewAspect = 'full' | '16:9' | '9:16' | '1:1';

export const PREVIEW_ASPECTS: { id: PreviewAspect; label: string; ratio: number | null }[] = [
  { id: 'full', label: 'FULL', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '1:1', label: '1:1', ratio: 1 },
];

interface UiState {
  hidden: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  browserOpen: boolean;
  exportOpen: boolean;
  previewAspect: PreviewAspect;
  safeZones: boolean;
  hideUi: () => void;
  showUi: () => void;
  toggleUi: () => void;
  /** Escape: leave immersive mode first, then close the top-most panel. Returns true if handled. */
  escape: (exportBusy: boolean) => boolean;
  openInspector: (tab?: InspectorTab) => void;
  closeInspector: () => void;
  toggleInspector: () => void;
  setTab: (tab: InspectorTab) => void;
  setBrowser: (open: boolean) => void;
  setExport: (open: boolean) => void;
  setPreviewAspect: (a: PreviewAspect) => void;
  toggleSafeZones: () => void;
}

export const useUi = create<UiState>()((set, get) => ({
  hidden: false,
  inspectorOpen: false,
  inspectorTab: 'scene',
  browserOpen: false,
  exportOpen: false,
  previewAspect: 'full',
  safeZones: true,
  hideUi: () => set({ hidden: true }),
  showUi: () => set({ hidden: false }),
  toggleUi: () => set({ hidden: !get().hidden }),
  escape: (exportBusy) => {
    const s = get();
    if (s.hidden) {
      set({ hidden: false });
      return true;
    }
    if (s.exportOpen && !exportBusy) {
      set({ exportOpen: false });
      return true;
    }
    if (s.browserOpen) {
      set({ browserOpen: false });
      return true;
    }
    if (s.inspectorOpen) {
      set({ inspectorOpen: false });
      return true;
    }
    return false;
  },
  openInspector: (tab) => set({ inspectorOpen: true, inspectorTab: tab ?? get().inspectorTab }),
  closeInspector: () => set({ inspectorOpen: false }),
  toggleInspector: () => set({ inspectorOpen: !get().inspectorOpen }),
  setTab: (tab) => set({ inspectorTab: tab }),
  setBrowser: (open) => set({ browserOpen: open }),
  setExport: (open) => set({ exportOpen: open }),
  setPreviewAspect: (a) => set({ previewAspect: a }),
  toggleSafeZones: () => set({ safeZones: !get().safeZones }),
}));

/**
 * Restore-button visibility while the UI is hidden: shown when the pointer is in the
 * top-right corner region or after a touch, for `holdMs`.
 */
export function inRestoreCorner(x: number, y: number, width: number, size = 140): boolean {
  return x >= width - size && y <= size;
}

/** Size of the largest `ratio` box that fits `w × h` (with a small margin) — the preview frame. */
export function fitBox(w: number, h: number, ratio: number, margin = 0.92): { width: number; height: number } {
  const mw = w * margin;
  const mh = h * margin;
  return mw / mh > ratio ? { width: Math.round(mh * ratio), height: Math.round(mh) } : { width: Math.round(mw), height: Math.round(mw / ratio) };
}
