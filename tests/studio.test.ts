/**
 * Export Studio orchestration: the job that reaches the renderer and the lifetime of the
 * file on disk. The renderer, the audio engine and the save dialog are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportSpec } from '../src/export/plan';
import type { RenderJob } from '../src/export/RenderController';

const seen: { jobs: RenderJob[]; behaviour: 'ok' | 'throw' | 'hang' } = { jobs: [], behaviour: 'ok' };
let currentFile: File | null = new File([new Uint8Array(4)], 'short.wav');

vi.mock('../src/audio/controller', () => ({
  engine: { pause() {} },
  getCurrentFile: () => currentFile,
}));
vi.mock('../src/export/RenderController', () => ({
  RenderController: class {
    cancelled = false;
    constructor(
      readonly job: RenderJob,
      readonly onProgress: (p: { phase: string }) => void,
    ) {
      seen.jobs.push(job);
    }
    cancel() {
      this.cancelled = true;
    }
    async run() {
      if (seen.behaviour === 'throw') throw new Error('ENCODER ERROR');
      if (this.job.disk) await this.job.disk.commit();
      return { blob: this.job.disk ? null : new Blob(['x']), bytes: 1, mimeType: 'video/mp4', frames: 30, durationSeconds: 1, elapsedMs: 5 };
    }
  },
}));

const { startExport, cancelExport, useStudio, discardResult } = await import('../src/export/studio');
const { usePlayer } = await import('../src/state/player');

class FakeDiskFile {
  closeCalls = 0;
  abortCalls = 0;
  async write() {}
  async close() {
    this.closeCalls++;
  }
  async abort() {
    this.abortCalls++;
  }
}

const spec = (over: Partial<ExportSpec> = {}): ExportSpec => ({
  container: 'mp4',
  videoCodec: 'avc',
  audioCodec: 'aac',
  width: 1280,
  height: 720,
  fps: 30,
  quality: 'standard',
  videoBitrate: 3e6,
  audioBitrate: 192000,
  start: 0,
  end: 1,
  ...over,
});

let disk: FakeDiskFile;
beforeEach(() => {
  seen.jobs = [];
  seen.behaviour = 'ok';
  currentFile = new File([new Uint8Array(4)], 'short.wav');
  disk = new FakeDiskFile();
  usePlayer.setState({ duration: 1, status: 'ready' });
  useStudio.setState({ status: 'idle', progress: null, result: null, error: null, cancelRequested: false });
  vi.stubGlobal('window', {
    showSaveFilePicker: async () => ({ createWritable: async () => disk }),
  });
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }));
});
afterEach(() => {
  discardResult();
  vi.unstubAllGlobals();
});

describe('startExport — the range that reaches the renderer', () => {
  it('a selection left over from a longer track is clamped to the loaded track', async () => {
    // 28 s track, segment 10–20 s selected, then a 1 s track is loaded
    await startExport(spec({ start: 10, end: 20 }), 'balanced', false);
    const job = seen.jobs[0].spec;
    expect(job.end).toBeLessThanOrEqual(1);
    expect(job.end - job.start).toBeGreaterThanOrEqual(0.5);
    expect(useStudio.getState().status).toBe('done');
  });

  it('a track shorter than the minimum fragment is exported whole', async () => {
    usePlayer.setState({ duration: 0.3 });
    await startExport(spec({ start: 0, end: 28 }), 'balanced', false);
    expect(seen.jobs[0].spec.start).toBe(0);
    expect(seen.jobs[0].spec.end).toBe(0.3);
  });

  it('nothing is rendered without audio', async () => {
    usePlayer.setState({ duration: 0 });
    await startExport(spec(), 'balanced', false);
    expect(seen.jobs).toHaveLength(0);
    expect(useStudio.getState().status).toBe('error');
  });
});

describe('startExport — file on disk', () => {
  it('a successful export commits the file once', async () => {
    await startExport(spec(), 'balanced', true);
    expect(disk.closeCalls).toBe(1);
    expect(disk.abortCalls).toBe(0);
    expect(useStudio.getState().result?.toDisk).toBe(true);
  });

  it('a failing render aborts the file (nothing replaced)', async () => {
    seen.behaviour = 'throw';
    await startExport(spec(), 'balanced', true);
    expect(useStudio.getState().status).toBe('error');
    expect(disk.closeCalls).toBe(0);
    expect(disk.abortCalls).toBe(1);
  });

  it('closing the save dialog is not an error and writes nothing', async () => {
    vi.stubGlobal('window', {
      showSaveFilePicker: async () => {
        throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
      },
    });
    await startExport(spec(), 'balanced', true);
    expect(useStudio.getState().status).toBe('idle');
    expect(seen.jobs).toHaveLength(0);
  });

  it('a file that cannot be opened for writing is reported', async () => {
    vi.stubGlobal('window', {
      showSaveFilePicker: async () => ({
        createWritable: async () => {
          throw Object.assign(new Error('The request is not allowed'), { name: 'NotAllowedError' });
        },
      }),
    });
    await startExport(spec(), 'balanced', true);
    expect(useStudio.getState().status).toBe('error');
    expect(useStudio.getState().error).toMatch(/CANNOT WRITE THE FILE/);
  });
});

describe('cancelExport', () => {
  it('is ignored while the finished file is being saved', () => {
    useStudio.setState({ status: 'running', progress: { phase: 'saving', frame: 30, totalFrames: 30, elapsedMs: 1, speed: 1, etaMs: 0, bytes: 1 } });
    cancelExport();
    expect(useStudio.getState().cancelRequested).toBe(false);
  });

  it('is recorded while rendering or finalizing', () => {
    for (const phase of ['rendering', 'finalizing'] as const) {
      useStudio.setState({ status: 'running', cancelRequested: false, progress: { phase, frame: 3, totalFrames: 30, elapsedMs: 1, speed: 1, etaMs: 0, bytes: 1 } });
      cancelExport();
      expect(useStudio.getState().cancelRequested).toBe(true);
    }
  });
});
