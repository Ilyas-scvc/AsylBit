/**
 * RenderController control flow with a stand-in Mediabunny and engine. These tests cover
 * timestamps, trimming, cancel and error paths only — they are NOT proof that real files
 * play: that is checked by encoding in a browser and inspecting the output with ffprobe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synthesizeTestPattern } from '../src/audio/dsp/testPattern';
import { qualityProfile } from '../src/engine/quality';
import type { ExportSpec } from '../src/export/plan';

const SR = 48000;
const pattern = synthesizeTestPattern(SR, 120);

interface Log {
  videoTimestamps: number[];
  audio: { timestamp: number; frames: number; channels: number }[];
  finalized: boolean;
  cancelled: boolean;
  renders: number;
  disposed: boolean;
  contextLost: boolean;
  writeListeners: ((e: { start: number; end: number }) => void)[];
  failVideoAt: number;
  onVideoFrame: (n: number) => void;
  noTrack: boolean;
}
const log: Log = {} as Log;

function resetLog() {
  Object.assign(log, {
    videoTimestamps: [],
    audio: [],
    finalized: false,
    cancelled: false,
    renders: 0,
    disposed: false,
    contextLost: false,
    writeListeners: [],
    failVideoAt: -1,
    onVideoFrame: () => {},
    noTrack: false,
  });
}

const fakeMediabunny = {
  ALL_FORMATS: [],
  BlobSource: class {},
  Quality: class {
    constructor(readonly opts: unknown) {}
  },
  BufferTarget: class {
    buffer = new ArrayBuffer(16);
    on(_e: string, fn: (e: { start: number; end: number }) => void) {
      log.writeListeners.push(fn);
    }
  },
  StreamTarget: class {
    on(_e: string, fn: (e: { start: number; end: number }) => void) {
      log.writeListeners.push(fn);
    }
  },
  Mp4OutputFormat: class {},
  MovOutputFormat: class {},
  WebMOutputFormat: class {},
  Output: class {
    addVideoTrack() {}
    addAudioTrack() {}
    async start() {}
    async getMimeType() {
      return 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
    }
    async finalize() {
      log.finalized = true;
    }
    async cancel() {
      log.cancelled = true;
    }
  },
  CanvasSource: class {
    async add(timestamp: number) {
      const n = log.videoTimestamps.length;
      if (n === log.failVideoAt) throw new Error('ENCODER ERROR: hardware encoder lost');
      log.videoTimestamps.push(timestamp);
      log.onVideoFrame(n);
    }
    close() {}
  },
  AudioSampleSource: class {
    async add(s: { timestamp: number; numberOfFrames: number; numberOfChannels: number }) {
      log.audio.push({ timestamp: s.timestamp, frames: s.numberOfFrames, channels: s.numberOfChannels });
    }
    close() {}
  },
  AudioSample: class {
    readonly timestamp: number;
    readonly numberOfFrames: number;
    readonly numberOfChannels: number;
    constructor(init: { data: Float32Array; numberOfChannels: number; timestamp: number }) {
      this.timestamp = init.timestamp;
      this.numberOfChannels = init.numberOfChannels;
      this.numberOfFrames = init.data.length / init.numberOfChannels;
    }
    close() {}
  },
  Input: class {
    async getPrimaryAudioTrack() {
      return log.noTrack ? null : { canDecode: async () => true };
    }
    dispose() {}
  },
  AudioSampleSink: class {
    async *samples(from: number, to: number) {
      // stereo test pattern decoded in 1024-frame packets, like an AAC/MP3 decoder would
      const first = Math.floor(from * SR);
      const last = Math.min(pattern.samples.length, Math.ceil(to * SR));
      for (let i = first - (first % 1024); i < last; i += 1024) {
        const n = Math.min(1024, pattern.samples.length - i);
        yield {
          numberOfFrames: n,
          numberOfChannels: 2,
          sampleRate: SR,
          timestamp: i / SR,
          copyTo(dst: Float32Array) {
            dst.set(pattern.samples.subarray(i, i + n));
          },
          close() {},
        };
      }
    }
  },
};

const polyfill = { on: false };
vi.mock('../src/export/capabilities', () => ({
  loadMediabunny: async () => fakeMediabunny,
  aacPolyfillActive: () => polyfill.on,
  AAC_POLYFILL_PRIMING_FRAMES: 1024,
}));
vi.mock('../src/engine/VisualizerEngine', () => ({
  VisualizerEngine: class {
    renderer = {
      forceContextLoss: () => {
        log.contextLost = true;
      },
    };
    setSize() {}
    render(input: { skipRender?: boolean }) {
      if (!input.skipRender) log.renders++;
    }
    dispose() {
      log.disposed = true;
    }
  },
}));

const { ExportCancelledError, RenderController } = await import('../src/export/RenderController');

function job(over: Partial<ExportSpec> = {}) {
  const spec: ExportSpec = {
    container: 'mp4',
    videoCodec: 'avc',
    audioCodec: 'aac',
    width: 640,
    height: 360,
    fps: 30,
    quality: 'standard',
    videoBitrate: 2e6,
    audioBitrate: 192000,
    start: 2.95,
    end: 5.95,
    ...over,
  };
  return {
    spec,
    file: new File([new Uint8Array(8)], 'track.wav'),
    eventMap: null,
    visual: { sceneId: 'pulse-object', params: {}, modulations: [], post: [] },
    quality: qualityProfile('balanced'),
    fftSize: 2048,
    reducedMotion: false,
  };
}

beforeEach(() => {
  resetLog();
  polyfill.on = false;
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) });
});
afterEach(() => vi.unstubAllGlobals());

describe('RenderController (mocked encoder)', () => {
  it('emits every frame at n / fps from 0, and exactly the trimmed audio from 0', async () => {
    const r = await new RenderController(job()).run();
    expect(r.frames).toBe(90);
    expect(log.videoTimestamps).toHaveLength(90);
    log.videoTimestamps.forEach((t, n) => expect(t).toBe(n / 30));
    // audio: contiguous, starting at 0, exactly (end - start) × 48 kHz frames, stereo
    expect(log.audio[0].timestamp).toBe(0);
    let expected = 0;
    for (const a of log.audio) {
      expect(Math.round(a.timestamp * SR)).toBe(expected);
      expect(a.channels).toBe(2);
      expected += a.frames;
    }
    expect(expected).toBe(3 * SR);
    expect(log.finalized).toBe(true);
    expect(log.cancelled).toBe(false);
  });

  it('starts the audio before 0 by the WASM AAC encoder delay, so the edit list trims it', async () => {
    polyfill.on = true;
    await new RenderController(job()).run();
    expect(log.audio[0].timestamp).toBeCloseTo(-1024 / SR, 9);
    const total = log.audio.reduce((n, a) => n + a.frames, 0);
    expect(total).toBe(3 * SR);
    // Opus (WebM) is never shifted
    resetLog();
    await new RenderController(job({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' })).run();
    expect(log.audio[0].timestamp).toBe(0);
  });

  it('warms up stateful effects in a drawn pre-roll that never reaches the file', async () => {
    await new RenderController(job()).run();
    // the last second of pre-roll is drawn (30 frames) in addition to the 90 output frames
    expect(log.renders).toBe(120);
    expect(log.videoTimestamps).toHaveLength(90);
  });

  it('releases the GPU context after a successful export', async () => {
    await new RenderController(job()).run();
    expect(log.disposed).toBe(true);
    expect(log.contextLost).toBe(true);
  });

  it('cancels cleanly: no finalize, output cancelled, engine disposed', async () => {
    const c = new RenderController(job());
    log.onVideoFrame = (n) => {
      if (n === 10) c.cancel();
    };
    await expect(c.run()).rejects.toBeInstanceOf(ExportCancelledError);
    expect(log.finalized).toBe(false);
    expect(log.cancelled).toBe(true);
    expect(log.disposed).toBe(true);
    expect(log.videoTimestamps.length).toBeLessThan(20);
  });

  it('surfaces encoder errors and cleans up', async () => {
    log.failVideoAt = 20;
    await expect(new RenderController(job()).run()).rejects.toThrow(/ENCODER ERROR/);
    expect(log.finalized).toBe(false);
    expect(log.cancelled).toBe(true);
    expect(log.disposed).toBe(true);
  });

  it('stops before an in-memory file outgrows the memory limit', async () => {
    log.onVideoFrame = (n) => {
      if (n === 5) for (const fn of log.writeListeners) fn({ start: 0, end: 2 * 1024 ** 3 });
    };
    await expect(new RenderController(job()).run()).rejects.toThrow(/IN-MEMORY LIMIT/);
    expect(log.cancelled).toBe(true);
    expect(log.disposed).toBe(true);
  });

  it('reports a file it cannot decode instead of writing a silent video', async () => {
    log.noTrack = true;
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData() {
          return Promise.reject(new Error('Unable to decode audio data'));
        }
      },
    );
    await expect(new RenderController(job()).run()).rejects.toThrow(/decode/i);
    expect(log.videoTimestamps).toHaveLength(0);
    expect(log.finalized).toBe(false);
    expect(log.disposed).toBe(true);
  });

  it('reports progress monotonically up to the last frame', async () => {
    const reports: { phase: string; frame: number; totalFrames: number }[] = [];
    await new RenderController(job(), (p) => reports.push(p)).run();
    for (let i = 1; i < reports.length; i++) expect(reports[i].frame).toBeGreaterThanOrEqual(reports[i - 1].frame);
    expect(reports.some((r) => r.phase === 'rendering')).toBe(true);
    expect(reports.at(-1)).toMatchObject({ phase: 'finalizing', frame: 90, totalFrames: 90 });
  });
});
