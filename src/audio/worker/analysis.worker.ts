/// <reference lib="webworker" />
/**
 * Pre-analysis worker. Receives decoded PCM channels (transferred, not copied), runs the
 * offline analysis and transfers the typed-array results back. Cancellation is done by the
 * main thread terminating the worker.
 */
import { analyzeOffline, downmix } from '../dsp/offlineAnalysis';
import type { AnalyzeRequest, WorkerResponse } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const msg = event.data;
  if (msg.type !== 'analyze') return;
  const { jobId } = msg;
  try {
    const mono = downmix(msg.channels);
    msg.channels.length = 0; // drop the per-channel copies as early as possible
    let last = -1;
    const result = analyzeOffline(mono, msg.sampleRate, {
      onProgress: (p) => {
        const pct = Math.floor(p * 100);
        if (pct !== last) {
          last = pct;
          scope.postMessage({ type: 'progress', jobId, progress: p } satisfies WorkerResponse);
        }
      },
    });
    const transfer: Transferable[] = [
      result.waveform.buffer,
      result.bandMap.buffer,
      result.events.times.buffer,
      result.events.strengths.buffer,
      result.events.types.buffer,
    ];
    scope.postMessage({ type: 'result', jobId, result } satisfies WorkerResponse, transfer);
  } catch (err) {
    scope.postMessage({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
