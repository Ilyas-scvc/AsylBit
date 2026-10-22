import type { OfflineAnalysisResult } from '../dsp/offlineAnalysis';

export interface AnalyzeRequest {
  type: 'analyze';
  jobId: number;
  channels: Float32Array[];
  sampleRate: number;
}

export type WorkerResponse =
  | { type: 'progress'; jobId: number; progress: number }
  | { type: 'result'; jobId: number; result: OfflineAnalysisResult }
  | { type: 'error'; jobId: number; message: string };
