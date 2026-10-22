/**
 * Main-thread side of the pre-analysis pipeline:
 *
 *   File → ArrayBuffer → decodeAudioData (resampled to 22.05 kHz) → Worker → result
 *
 * Decoding at a reduced rate bounds memory (a 10 min stereo track is ~100 MB instead of
 * ~230 MB at 48 kHz) and is plenty for onset detection up to ~11 kHz. Every job can be
 * aborted; the worker is terminated so no stale result can arrive after a file change.
 * Results are cached in memory (small LRU) for the lifetime of the page.
 */
import type { OfflineAnalysisResult } from '../dsp/offlineAnalysis';
import type { AnalyzeRequest, WorkerResponse } from '../worker/protocol';

export const ANALYSIS_SAMPLE_RATE = 22050;
/** Tracks longer than this are visualised in real-time mode only (bounds memory use). */
export const MAX_ANALYSIS_SECONDS = 15 * 60;
const CACHE_SIZE = 3;

export type PreAnalysisPhase = 'decoding' | 'analyzing';

export class AnalysisAbortedError extends Error {
  constructor() {
    super('analysis aborted');
    this.name = 'AnalysisAbortedError';
  }
}

export function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export class PreAnalyzer {
  private worker: Worker | null = null;
  private jobId = 0;
  private abortCurrent: (() => void) | null = null;
  private readonly cache = new Map<string, OfflineAnalysisResult>();

  getCached(file: File): OfflineAnalysisResult | null {
    const key = fileKey(file);
    const hit = this.cache.get(key);
    if (!hit) return null;
    this.cache.delete(key); // refresh LRU position
    this.cache.set(key, hit);
    return hit;
  }

  /** Abort the running job (if any) and terminate its worker. */
  cancel(): void {
    this.abortCurrent?.();
    this.abortCurrent = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  async analyze(
    file: File,
    onPhase: (phase: PreAnalysisPhase) => void,
    onProgress: (fraction: number) => void,
  ): Promise<OfflineAnalysisResult> {
    this.cancel();
    const cached = this.getCached(file);
    if (cached) return cached;

    const jobId = ++this.jobId;
    let aborted = false;
    let rejectRun: ((e: Error) => void) | null = null;
    this.abortCurrent = () => {
      aborted = true;
      rejectRun?.(new AnalysisAbortedError());
    };
    const check = () => {
      if (aborted || jobId !== this.jobId) throw new AnalysisAbortedError();
    };

    onPhase('decoding');
    const bytes = await file.arrayBuffer();
    check();
    const channels = await decodeToChannels(bytes);
    check();

    onPhase('analyzing');
    const worker = new Worker(new URL('../worker/analysis.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const result = await new Promise<OfflineAnalysisResult>((resolve, reject) => {
      rejectRun = reject;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (msg.jobId !== jobId) return;
        if (msg.type === 'progress') onProgress(msg.progress);
        else if (msg.type === 'result') resolve(msg.result);
        else reject(new Error(msg.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'ANALYSIS WORKER FAILED'));
      const request: AnalyzeRequest = { type: 'analyze', jobId, channels, sampleRate: ANALYSIS_SAMPLE_RATE };
      worker.postMessage(request, channels.map((c) => c.buffer));
    }).finally(() => {
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      if (jobId === this.jobId) this.abortCurrent = null;
    });
    check();

    this.cache.set(fileKey(file), result);
    while (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return result;
  }
}

/**
 * Decode compressed audio into mono PCM at the analysis rate. Uses an OfflineAudioContext
 * so decoding never touches the playback context.
 */
async function decodeToChannels(bytes: ArrayBuffer): Promise<Float32Array[]> {
  const Offline: typeof OfflineAudioContext =
    window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Offline(1, 1, ANALYSIS_SAMPLE_RATE);
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error('DECODER COULD NOT READ THIS FILE');
  }
  if (buffer.duration > MAX_ANALYSIS_SECONDS) {
    throw new Error(`TRACK LONGER THAN ${MAX_ANALYSIS_SECONDS / 60} MIN — REAL-TIME MODE ONLY`);
  }
  // Downmix here, one channel at a time, so only a single mono copy is transferred and the
  // decoded AudioBuffer can be garbage-collected right after.
  const mono = new Float32Array(buffer.length);
  buffer.copyFromChannel(mono, 0);
  if (buffer.numberOfChannels > 1) {
    const tmp = new Float32Array(buffer.length);
    const n = buffer.numberOfChannels;
    for (let c = 1; c < n; c++) {
      buffer.copyFromChannel(tmp, c);
      for (let i = 0; i < mono.length; i++) mono[i] += tmp[i];
    }
    const g = 1 / n;
    for (let i = 0; i < mono.length; i++) mono[i] *= g;
  }
  return [mono];
}
