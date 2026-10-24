/**
 * RenderController control flow with a stand-in Mediabunny and engine. These tests cover
 * timestamps, trimming, cancel / error paths, the commit boundary and the memory limit — they
 * are NOT proof that real files play: that is checked with the real library
 * (exportSinks.integration.test.ts), in the browser and with ffprobe.
 *
 * The fake follows the real library where it matters: packets are written into the target's
 * WritableStream as they are produced, and both finalize() and cancel() close that stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { synthesizeTestPattern } from '../src/audio/dsp/testPattern';
import { qualityProfile } from '../src/engine/quality';
import type { ExportSpec } from '../src/export/plan';
import { OutputLimitError, TransactionalFileSink, type WriteChunk } from '../src/export/sinks';

const SR = 48000;
const pattern = synthesizeTestPattern(SR, 120);
const PACKET_BYTES = 1000;

interface Log {
  videoTimestamps: number[];
  audio: { timestamp: number; frames: number; channels: number }[];
  finalized: boolean;
  cancelled: boolean;
  renders: number;
  engines: number;
  disposed: number;
  contextLost: boolean;
  failVideoAt: number;
  failFinalize: boolean;
  failMediabunnyLoad: boolean;
  failEngine: boolean;
  onVideoFrame: (n: number) => void;
  noTrack: boolean;
  closedStreams: number;
}
const log: Log = {} as Log;

function resetLog() {
  Object.assign(log, {
    videoTimestamps: [],
    audio: [],
    finalized: false,
    cancelled: false,
    renders: 0,
    engines: 0,
    disposed: 0,
    contextLost: false,
    failVideoAt: -1,
    failFinalize: false,
    failMediabunnyLoad: false,
    failEngine: false,
    onVideoFrame: () => {},
    noTrack: false,
    closedStreams: 0,
  });
}

class FakeOutput {
  writer: WritableStreamDefaultWriter<unknown> | null = null;
  position = 0;
  constructor(readonly opts: { target: { writable: WritableStream } }) {}
  addVideoTrack(source: { output: FakeOutput }) {
    source.output = this;
  }
  addAudioTrack() {}
  async start() {
    this.writer = this.opts.target.writable.getWriter();
    await this.write(new Uint8Array(64)); // header, rewritten at finalize
  }
  async write(data: Uint8Array, position = this.position) {
    await this.writer!.ready;
    await this.writer!.write({ type: 'write', data, position });
    this.position = Math.max(this.position, position + data.byteLength);
  }
  async getMimeType() {
    return 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
  }
  async finalize() {
    await this.write(new Uint8Array(64).fill(7), 0);
    if (log.failFinalize) {
      await this.writer!.close().catch(() => {}); // the real library closes the target on a failed finalize
      log.closedStreams++;
      throw new Error('FINALIZE FAILED: moov too large');
    }
    await this.writer!.close();
    log.closedStreams++;
    log.finalized = true;
  }
  async cancel() {
    log.cancelled = true;
    // like Mediabunny: cancel closes the target's stream (for a file that would commit it)
    await this.writer?.close().catch(() => {});
    log.closedStreams++;
  }
}

const fakeMediabunny = {
  ALL_FORMATS: [],
  BlobSource: class {},
  Quality: class {
    constructor(readonly opts: unknown) {}
  },
  StreamTarget: class {
    constructor(readonly writable: WritableStream) {}
  },
  Mp4OutputFormat: class {},
  MovOutputFormat: class {},
  WebMOutputFormat: class {},
  Output: FakeOutput,
  CanvasSource: class {
    output!: FakeOutput;
    async add(timestamp: number) {
      const n = log.videoTimestamps.length;
      if (n === log.failVideoAt) throw new Error('ENCODER ERROR: hardware encoder lost');
      log.videoTimestamps.push(timestamp);
      await this.output.write(new Uint8Array(PACKET_BYTES).fill(n & 255));
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
  loadMediabunny: async () => {
    if (log.failMediabunnyLoad) throw new Error('Failed to fetch dynamically imported module');
    return fakeMediabunny;
  },
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
    constructor() {
      if (log.failEngine) throw new Error('WEBGL CONTEXT COULD NOT BE CREATED');
      log.engines++;
    }
    setSize() {}
    render(input: { skipRender?: boolean }) {
      if (!input.skipRender) log.renders++;
    }
    dispose() {
      log.disposed++;
    }
  },
}));

const { ExportCancelledError, RenderController } = await import('../src/export/RenderController');

/** FileSystemWritableFileStream semantics: writes go to a swap file, close() replaces the file, abort() discards. */
class FakeDiskFile {
  committed: Uint8Array;
  private swap = new Uint8Array(0);
  closeCalls = 0;
  abortCalls = 0;
  failClose = false;
  constructor(original: string) {
    this.committed = new TextEncoder().encode(original);
  }
  async write(chunk: WriteChunk) {
    const end = chunk.position + chunk.data.byteLength;
    if (end > this.swap.length) {
      const grown = new Uint8Array(end);
      grown.set(this.swap);
      this.swap = grown;
    }
    this.swap.set(chunk.data, chunk.position);
  }
  async close() {
    this.closeCalls++;
    if (this.failClose) throw new Error('QuotaExceededError');
    this.committed = this.swap;
  }
  async abort() {
    this.abortCalls++;
    this.swap = new Uint8Array(0);
  }
  get text() {
    return new TextDecoder().decode(this.committed);
  }
}

const ORIGINAL = 'ORIGINAL FILE CONTENTS'; // 22 bytes, as in the review

function job(over: Partial<ExportSpec> = {}, extra: { disk?: TransactionalFileSink; memoryLimitBytes?: number } = {}) {
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
    ...extra,
  };
}

beforeEach(() => {
  resetLog();
  polyfill.on = false;
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0 }) });
});
afterEach(() => vi.unstubAllGlobals());

describe('RenderController — frames and audio (mocked encoder)', () => {
  it('emits every frame at n / fps from 0, and exactly the trimmed audio from 0', async () => {
    const r = await new RenderController(job()).run();
    expect(r.frames).toBe(90);
    expect(log.videoTimestamps).toHaveLength(90);
    log.videoTimestamps.forEach((t, n) => expect(t).toBe(n / 30));
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
    expect(log.audio.reduce((n, a) => n + a.frames, 0)).toBe(3 * SR);
    resetLog();
    await new RenderController(job({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' })).run();
    expect(log.audio[0].timestamp).toBe(0);
  });

  it('warms up stateful effects in a drawn pre-roll that never reaches the file', async () => {
    await new RenderController(job()).run();
    expect(log.renders).toBe(120); // the last second of pre-roll (30) + 90 output frames
    expect(log.videoTimestamps).toHaveLength(90);
  });

  it('the in-memory result contains exactly the bytes the muxer wrote, header rewrite included', async () => {
    const r = await new RenderController(job()).run();
    expect(r.blob).not.toBeNull();
    expect(r.bytes).toBe(64 + 90 * PACKET_BYTES);
    const bytes = new Uint8Array(await r.blob!.arrayBuffer());
    expect(bytes.length).toBe(64 + 90 * PACKET_BYTES);
    expect(bytes[0]).toBe(7); // the header written at finalize replaced the placeholder
    expect(bytes[64]).toBe(0);
    expect(bytes[64 + PACKET_BYTES * 5]).toBe(5);
  });

  it('reports progress monotonically and ends with the final phase', async () => {
    const reports: { phase: string; frame: number; totalFrames: number; bytes: number }[] = [];
    await new RenderController(job(), (p) => reports.push(p)).run();
    for (let i = 1; i < reports.length; i++) expect(reports[i].frame).toBeGreaterThanOrEqual(reports[i - 1].frame);
    expect(reports.some((r) => r.phase === 'rendering')).toBe(true);
    expect(reports.at(-1)).toMatchObject({ phase: 'finalizing', frame: 90, totalFrames: 90 });
    // the size is real while rendering, not only after finalize
    const mid = reports.filter((r) => r.phase === 'rendering' && r.frame > 40)[0];
    expect(mid.bytes).toBeGreaterThan(30 * PACKET_BYTES);
  });

  it('refuses an empty range', async () => {
    await expect(new RenderController(job({ start: 5, end: 5 })).run()).rejects.toThrow(/EMPTY EXPORT RANGE/);
  });
});

describe('RenderController — writing to a file on disk', () => {
  it('a successful export replaces the file exactly once, at the end', async () => {
    const file = new FakeDiskFile(ORIGINAL);
    const disk = new TransactionalFileSink(file);
    const phases: string[] = [];
    const r = await new RenderController(job({}, { disk }), (p) => phases.push(p.phase)).run();
    expect(r.blob).toBeNull();
    expect(file.closeCalls).toBe(1);
    expect(file.abortCalls).toBe(0);
    expect(file.committed.length).toBe(64 + 90 * PACKET_BYTES);
    expect(disk.state).toBe('committed');
    expect(phases.at(-1)).toBe('saving');
  });

  it('cancel while rendering leaves the existing file untouched', async () => {
    const file = new FakeDiskFile(ORIGINAL);
    const c = new RenderController(job({}, { disk: new TransactionalFileSink(file) }));
    log.onVideoFrame = (n) => {
      if (n === 10) c.cancel();
    };
    await expect(c.run()).rejects.toBeInstanceOf(ExportCancelledError);
    expect(log.closedStreams).toBeGreaterThan(0); // the muxer did close its stream …
    expect(file.closeCalls).toBe(0); // … but the file was never committed
    expect(file.abortCalls).toBe(1);
    expect(file.text).toBe(ORIGINAL);
    expect(log.disposed).toBe(1);
    expect(log.contextLost).toBe(true);
  });

  it('cancel during finalizing is honoured: nothing is saved', async () => {
    const file = new FakeDiskFile(ORIGINAL);
    const c = new RenderController(job({}, { disk: new TransactionalFileSink(file) }), (p) => {
      if (p.phase === 'finalizing') c.cancel();
    });
    await expect(c.run()).rejects.toBeInstanceOf(ExportCancelledError);
    expect(log.finalized).toBe(true); // the library finished finalizing …
    expect(file.closeCalls).toBe(0); // … and the result was discarded
    expect(file.text).toBe(ORIGINAL);
  });

  it('cancel requested while saving does not undo the save (the result is reported)', async () => {
    const file = new FakeDiskFile(ORIGINAL);
    const c = new RenderController(job({}, { disk: new TransactionalFileSink(file) }), (p) => {
      if (p.phase === 'saving') c.cancel();
    });
    const r = await c.run();
    expect(r.frames).toBe(90);
    expect(file.closeCalls).toBe(1);
    expect(file.committed.length).toBe(64 + 90 * PACKET_BYTES);
  });

  it('an encoder error leaves the existing file untouched', async () => {
    const file = new FakeDiskFile(ORIGINAL);
    log.failVideoAt = 20;
    await expect(new RenderController(job({}, { disk: new TransactionalFileSink(file) })).run()).rejects.toThrow(/ENCODER ERROR/);
    expect(file.text).toBe(ORIGINAL);
    expect(file.closeCalls).toBe(0);
    expect(log.disposed).toBe(1);
  });

  it('a failed finalize leaves the existing file untouched', async () => {
    const file = new FakeDiskFile(ORIGINAL);
    log.failFinalize = true;
    await expect(new RenderController(job({}, { disk: new TransactionalFileSink(file) })).run()).rejects.toThrow(/FINALIZE FAILED/);
    expect(file.text).toBe(ORIGINAL);
    expect(file.closeCalls).toBe(0);
  });

  it('errors before rendering starts abort the file and leak nothing', async () => {
    const a = new FakeDiskFile(ORIGINAL);
    log.failMediabunnyLoad = true;
    await expect(new RenderController(job({}, { disk: new TransactionalFileSink(a) })).run()).rejects.toThrow(/dynamically imported/);
    expect(a.abortCalls).toBe(1);
    expect(a.text).toBe(ORIGINAL);
    expect(log.engines).toBe(0);

    resetLog();
    const b = new FakeDiskFile(ORIGINAL);
    log.failEngine = true;
    await expect(new RenderController(job({}, { disk: new TransactionalFileSink(b) })).run()).rejects.toThrow(/WEBGL/);
    expect(b.abortCalls).toBe(1);
    expect(b.text).toBe(ORIGINAL);
  });

  it('a failed save is reported as an error, never as success', async () => {
    const file = new FakeDiskFile(ORIGINAL);
    file.failClose = true;
    await expect(new RenderController(job({}, { disk: new TransactionalFileSink(file) })).run()).rejects.toThrow(/COULD NOT SAVE/);
    expect(file.text).toBe(ORIGINAL);
  });

  it('a file it cannot decode is reported instead of writing a silent video', async () => {
    const file = new FakeDiskFile(ORIGINAL);
    log.noTrack = true;
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData() {
          return Promise.reject(new Error('Unable to decode audio data'));
        }
      },
    );
    await expect(new RenderController(job({}, { disk: new TransactionalFileSink(file) })).run()).rejects.toThrow(/decode/i);
    expect(log.videoTimestamps).toHaveLength(0);
    expect(file.text).toBe(ORIGINAL);
    expect(log.disposed).toBe(1);
  });
});

describe('RenderController — in-memory size limit', () => {
  it('stops as soon as the bytes actually written pass the limit', async () => {
    const limit = 40 * PACKET_BYTES;
    let lastFrame = 0;
    const c = new RenderController(job({}, { memoryLimitBytes: limit }), (p) => {
      lastFrame = Math.max(lastFrame, p.frame);
    });
    const err = await c.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutputLimitError);
    expect((err as Error).message).toMatch(/WRITE TO DISK/);
    expect(log.videoTimestamps.length).toBeLessThanOrEqual(41); // stopped right at the limit
    expect(log.finalized).toBe(false);
    expect(log.disposed).toBe(1);
  });

  it('a range that fits is unaffected', async () => {
    const r = await new RenderController(job({}, { memoryLimitBytes: 200 * PACKET_BYTES })).run();
    expect(r.blob!.size).toBe(64 + 90 * PACKET_BYTES);
  });

  it('cancel while rendering in memory gives no result', async () => {
    const c = new RenderController(job());
    log.onVideoFrame = (n) => {
      if (n === 10) c.cancel();
    };
    await expect(c.run()).rejects.toBeInstanceOf(ExportCancelledError);
    expect(log.finalized).toBe(false);
    expect(log.cancelled).toBe(true);
  });

  it('cancel during finalizing in memory gives no result either', async () => {
    const c = new RenderController(job(), (p) => {
      if (p.phase === 'finalizing') c.cancel();
    });
    await expect(c.run()).rejects.toBeInstanceOf(ExportCancelledError);
  });
});
