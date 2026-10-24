/**
 * Export Studio job orchestration: builds a RenderJob from the current track, look and
 * selections, runs the RenderController and exposes progress / result to the UI.
 */
import { create } from 'zustand';
import { engine as audioEngine, getCurrentFile } from '../audio/controller';
import { qualityProfile } from '../engine/quality';
import type { PerformancePreset } from '../engine/types';
import { usePlayer } from '../state/player';
import { resolveReducedMotion, useSettings } from '../state/settings';
import { useVisual, visualSnapshot } from '../state/visual';
import { systemPrefersReducedMotion } from '../visual/useReducedMotion';
import { useRuntime } from '../visual/runtime';
import { ExportCancelledError } from './errors';
import type { RenderController, RenderProgress } from './RenderController';
import { containerInfo, estimateBytes, exportFileName, MAX_IN_MEMORY_BYTES, type ExportSpec } from './plan';

export interface StudioResult {
  url: string | null;
  name: string;
  bytes: number;
  mimeType: string;
  frames: number;
  durationSeconds: number;
  elapsedMs: number;
  toDisk: boolean;
  spec: ExportSpec;
}

interface StudioState {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  progress: RenderProgress | null;
  result: StudioResult | null;
  error: string | null;
}

export const useStudio = create<StudioState>()(() => ({ status: 'idle', progress: null, result: null, error: null }));

let active: RenderController | null = null;
const previewListeners = new Set<(c: HTMLCanvasElement) => void>();

export function onExportPreview(fn: (c: HTMLCanvasElement) => void): () => void {
  previewListeners.add(fn);
  return () => previewListeners.delete(fn);
}

export function snapshotForExport() {
  // a deep copy: edits made while rendering never leak into the running export
  return structuredClone(visualSnapshot(useVisual.getState()));
}

export function exportReducedMotion(): boolean {
  return resolveReducedMotion(useSettings.getState().reducedMotion, systemPrefersReducedMotion());
}

export async function startExport(spec: ExportSpec, detail: PerformancePreset, toDisk: boolean): Promise<void> {
  if (useStudio.getState().status === 'running') return;
  const file = getCurrentFile();
  if (!file) {
    useStudio.setState({ status: 'error', error: 'LOAD AN AUDIO FILE FIRST' });
    return;
  }
  discardResult();
  const name = exportFileName(file.name, spec.container, spec.width, spec.height, spec.fps);
  const info = containerInfo(spec.container);
  let writable: FileSystemWritableFileStream | undefined;
  if (toDisk) {
    try {
      const picker = (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
      const handle = await picker({ suggestedName: name, types: [{ description: `${info.label} video`, accept: { [info.mime]: [`.${info.extension}`] } }] });
      writable = await handle.createWritable();
    } catch {
      return; // save dialog dismissed
    }
  } else if (estimateBytes(spec.videoBitrate, spec.audioBitrate, spec.end - spec.start) > MAX_IN_MEMORY_BYTES) {
    useStudio.setState({ status: 'error', error: 'ESTIMATED FILE TOO LARGE FOR MEMORY — ENABLE "WRITE TO DISK" OR SHORTEN THE RANGE' });
    return;
  }

  audioEngine.pause();
  useRuntime.setState({ offlineExport: true });
  useStudio.setState({ status: 'running', progress: null, result: null, error: null });
  let RenderControllerClass: typeof RenderController;
  try {
    ({ RenderController: RenderControllerClass } = await import('./RenderController'));
  } catch {
    useRuntime.setState({ offlineExport: false });
    useStudio.setState({ status: 'error', error: 'THE VIDEO RENDERER FAILED TO LOAD — CHECK THE CONNECTION AND TRY AGAIN' });
    return;
  }
  const controller = new RenderControllerClass(
    {
      spec,
      file,
      eventMap: usePlayer.getState().analysis?.events ?? null,
      visual: snapshotForExport(),
      quality: qualityProfile(detail),
      fftSize: useSettings.getState().fftSize,
      reducedMotion: exportReducedMotion(),
      writable,
    },
    (progress) => useStudio.setState({ progress }),
    (canvas) => previewListeners.forEach((fn) => fn(canvas)),
  );
  active = controller;
  try {
    const r = await controller.run();
    useStudio.setState({
      status: 'done',
      result: {
        url: r.blob ? URL.createObjectURL(r.blob) : null,
        name,
        bytes: r.bytes,
        mimeType: r.mimeType,
        frames: r.frames,
        durationSeconds: r.durationSeconds,
        elapsedMs: r.elapsedMs,
        toDisk: !!writable,
        spec,
      },
    });
  } catch (err) {
    if (err instanceof ExportCancelledError || controller.cancelled) useStudio.setState({ status: 'cancelled', progress: null });
    else useStudio.setState({ status: 'error', error: err instanceof Error ? err.message.toUpperCase() : 'EXPORT FAILED' });
  } finally {
    active = null;
    useRuntime.setState({ offlineExport: false });
  }
}

export function cancelExport(): void {
  active?.cancel();
}

export function discardResult(): void {
  const r = useStudio.getState().result;
  if (r?.url) URL.revokeObjectURL(r.url);
  useStudio.setState({ result: null, status: useStudio.getState().status === 'running' ? 'running' : 'idle', error: null });
}
