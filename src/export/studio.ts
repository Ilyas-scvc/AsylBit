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
import { TransactionalFileSink } from './sinks';
import { containerInfo, estimateBytes, exportFileName, exportRange, MAX_IN_MEMORY_BYTES, type ExportSpec } from './plan';

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
  /** cancel was pressed; the export stops at the next check (it cannot stop while saving) */
  cancelRequested: boolean;
}

export const useStudio = create<StudioState>()(() => ({ status: 'idle', progress: null, result: null, error: null, cancelRequested: false }));

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
  // never trust the UI selection: it may belong to a previously loaded, longer track
  const range = exportRange(spec.start, spec.end, usePlayer.getState().duration);
  if (!range) {
    useStudio.setState({ status: 'error', error: 'THE TRACK HAS NO AUDIO TO EXPORT' });
    return;
  }
  const job: ExportSpec = { ...spec, ...range };
  discardResult();
  const name = exportFileName(file.name, job.container, job.width, job.height, job.fps);
  const info = containerInfo(job.container);
  if (!toDisk && estimateBytes(job.videoBitrate, job.audioBitrate, job.end - job.start) > MAX_IN_MEMORY_BYTES) {
    // a first, estimate-based check; the real limit is enforced on the bytes actually written
    useStudio.setState({ status: 'error', error: 'ESTIMATED FILE TOO LARGE FOR MEMORY — ENABLE "WRITE TO DISK" OR SHORTEN THE RANGE' });
    return;
  }

  let disk: TransactionalFileSink | undefined;
  if (toDisk) {
    let writable: FileSystemWritableFileStream;
    try {
      const picker = (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
      const handle = await picker({ suggestedName: name, types: [{ description: `${info.label} video`, accept: { [info.mime]: [`.${info.extension}`] } }] });
      writable = await handle.createWritable();
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return; // save dialog dismissed
      useStudio.setState({ status: 'error', error: `CANNOT WRITE THE FILE — ${err instanceof Error ? err.message : String(err)}`.toUpperCase() });
      return;
    }
    disk = new TransactionalFileSink(writable);
  }

  audioEngine.pause();
  useRuntime.setState({ offlineExport: true });
  useStudio.setState({ status: 'running', progress: null, result: null, error: null, cancelRequested: false });
  let controller: RenderController | null = null;
  try {
    let RenderControllerClass: typeof RenderController;
    try {
      ({ RenderController: RenderControllerClass } = await import('./RenderController'));
    } catch {
      throw new Error('THE VIDEO RENDERER FAILED TO LOAD — CHECK THE CONNECTION AND TRY AGAIN');
    }
    controller = new RenderControllerClass(
      {
        spec: job,
        file,
        eventMap: usePlayer.getState().analysis?.events ?? null,
        visual: snapshotForExport(),
        quality: qualityProfile(detail),
        fftSize: useSettings.getState().fftSize,
        reducedMotion: exportReducedMotion(),
        disk,
        memoryLimitBytes: memoryLimitOverride ?? undefined,
      },
      (progress) => useStudio.setState({ progress }),
      (canvas) => previewListeners.forEach((fn) => fn(canvas)),
    );
    active = controller;
    if (useStudio.getState().cancelRequested) controller.cancel();
    const r = await controller.run();
    useStudio.setState({
      status: 'done',
      cancelRequested: false,
      result: {
        url: r.blob ? URL.createObjectURL(r.blob) : null,
        name,
        bytes: r.bytes,
        mimeType: r.mimeType,
        frames: r.frames,
        durationSeconds: r.durationSeconds,
        elapsedMs: r.elapsedMs,
        toDisk: !!disk,
        spec: job,
      },
    });
  } catch (err) {
    const cancelled = err instanceof ExportCancelledError || (controller?.cancelled ?? false) || useStudio.getState().cancelRequested;
    if (cancelled) useStudio.setState({ status: 'cancelled', progress: null, cancelRequested: false });
    else useStudio.setState({ status: 'error', error: err instanceof Error ? err.message.toUpperCase() : 'EXPORT FAILED', cancelRequested: false });
  } finally {
    // the file is only ever replaced by a successful commit; anything else is discarded
    if (disk && disk.state !== 'committed') await disk.abort();
    active = null;
    useRuntime.setState({ offlineExport: false });
  }
}

/** Request cancellation. Honoured until the finished file is being saved (phase 'saving'). */
export function cancelExport(): void {
  const s = useStudio.getState();
  if (s.status !== 'running' || s.progress?.phase === 'saving') return;
  useStudio.setState({ cancelRequested: true });
  active?.cancel();
}

/** Tests / diagnostics only: a smaller in-memory limit. */
let memoryLimitOverride: number | null = null;
export function setMemoryLimitForTesting(bytes: number | null): void {
  memoryLimitOverride = bytes;
}

export function discardResult(): void {
  const r = useStudio.getState().result;
  if (r?.url) URL.revokeObjectURL(r.url);
  useStudio.setState({ result: null, status: useStudio.getState().status === 'running' ? 'running' : 'idle', error: null });
}
