import { create } from 'zustand';

export type ExportAspect = '16:9' | '9:16' | '1:1';
export type ExportFps = 30 | 60;
export type ExportStatus = 'idle' | 'preparing' | 'recording' | 'finalizing' | 'done' | 'error';

export interface ExportResult {
  url: string;
  name: string;
  size: number;
  mime: string;
  width: number;
  height: number;
}

interface ExportState {
  status: ExportStatus;
  aspect: ExportAspect;
  fps: ExportFps;
  progress: number;
  error: string | null;
  result: ExportResult | null;
}

export const useExport = create<ExportState>()(() => ({
  status: 'idle',
  aspect: '16:9',
  fps: 30,
  progress: 0,
  error: null,
  result: null,
}));

export const EXPORT_SIZES: Record<ExportAspect, [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
};
