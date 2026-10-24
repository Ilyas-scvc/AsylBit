/**
 * RenderController — offline, frame-by-frame video renderer.
 *
 *   audio file ─ decode (streamed) ─┬─ mono ring ─ PcmAnalyser ─ AnalysisHub ─ AudioFrame ─┐
 *                                   │                                                     ▼
 *                                   │                       VisualizerEngine (export canvas, W×H)
 *                                   │                                                     │
 *                                   └─ trim [start,end) ─ AudioSampleSource (AAC / Opus)  │ CanvasSource
 *                                                         (H.264 / H.265 / VP9 / VP8)  ◄──┘
 *                                                   ▼
 *                                   Mediabunny Output → real MP4 / MOV / WebM
 *
 * Frame n shows music time `start + n / fps` and is stamped `n / fps`; the segment's audio
 * starts at timestamp 0 — so audio and video share one clock by construction. Rendering is
 * paced only by encoder backpressure (never by playback or requestAnimationFrame), so a
 * slow GPU makes the export take longer but never drops frames. A fixed pre-roll before
 * `start` warms up the analysis and the scene state deterministically.
 *
 * Output goes through a sink (sinks.ts): in memory with the real size counted as it is
 * written, or into a file that is committed only after everything succeeded. Cancel is
 * honoured up to that commit — including during finalization — so "cancelled" always means
 * nothing was saved.
 */
import { AnalysisHub } from '../audio/analysis/AnalysisHub';
import type { EventMap } from '../audio/dsp/events';
import { VisualizerEngine, type VisualSnapshot } from '../engine/VisualizerEngine';
import type { QualityProfile } from '../engine/types';
import { AAC_POLYFILL_PRIMING_FRAMES, aacPolyfillActive, loadMediabunny } from './capabilities';
import { ExportCancelledError } from './errors';
import { MemoryFileSink, type TransactionalFileSink } from './sinks';
import { PcmAnalyser, PcmRing, virtualEngine } from './PcmAnalyser';
import {
  analysisTime,
  AUDIO_SAMPLE_RATE,
  MAX_IN_MEMORY_BYTES,
  containerInfo,
  frameCount,
  frameTime,
  frameTimestamp,
  preRollStart,
  type ExportSpec,
} from './plan';

export interface RenderJob {
  spec: ExportSpec;
  file: File;
  eventMap: EventMap | null;
  visual: VisualSnapshot;
  quality: QualityProfile;
  fftSize: number;
  reducedMotion: boolean;
  /** stream straight to a file (File System Access API) instead of memory */
  disk?: TransactionalFileSink;
  /** in-memory size limit (bytes); defaults to MAX_IN_MEMORY_BYTES */
  memoryLimitBytes?: number;
}

/** 'saving' = committing the finished file to disk: the one step that cannot be cancelled. */
export type RenderPhase = 'preparing' | 'prerolling' | 'rendering' | 'finalizing' | 'saving';

export interface RenderProgress {
  phase: RenderPhase;
  frame: number;
  totalFrames: number;
  elapsedMs: number;
  /** rendered frames per second of wall time */
  speed: number;
  etaMs: number;
  bytes: number;
}

export interface RenderResult {
  blob: Blob | null;
  bytes: number;
  mimeType: string;
  frames: number;
  durationSeconds: number;
  elapsedMs: number;
}

export { ExportCancelledError };

/** Yield to the event loop without timer throttling (works in background tabs too). */
function yieldNow(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

interface DecodedChunk {
  /** planar channel data */
  channels: Float32Array[];
  sampleRate: number;
  /** absolute index of the first frame */
  firstFrame: number;
}

type Mediabunny = Awaited<ReturnType<typeof loadMediabunny>>;

/** Stream decoded audio for [from, to) — Mediabunny when it can read the file, otherwise Web Audio. */
async function* decodeAudio(mb: Mediabunny, file: File, from: number, to: number, signal: AbortSignal): AsyncGenerator<DecodedChunk> {
  let input: InstanceType<Mediabunny['Input']> | null = null;
  try {
    let track: Awaited<ReturnType<InstanceType<Mediabunny['Input']>['getPrimaryAudioTrack']>> = null;
    try {
      input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      track = await input.getPrimaryAudioTrack();
      if (track && !(await track.canDecode())) track = null;
    } catch {
      track = null; // container not readable by Mediabunny → Web Audio fallback below
    }
    if (track) {
      const sink = new mb.AudioSampleSink(track);
      for await (const sample of sink.samples(from, to)) {
        if (signal.aborted) {
          sample.close();
          throw new ExportCancelledError();
        }
        const n = sample.numberOfFrames;
        const channels: Float32Array[] = [];
        for (let c = 0; c < sample.numberOfChannels; c++) {
          const plane = new Float32Array(n);
          sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          channels.push(plane);
        }
        const chunk = { channels, sampleRate: sample.sampleRate, firstFrame: Math.round(sample.timestamp * sample.sampleRate) };
        sample.close();
        yield chunk;
      }
      return;
    }
  } finally {
    input?.dispose();
  }
  // Fallback: decode the whole file with Web Audio (bounded by a memory check).
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, AUDIO_SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(bytes);
  if (buffer.length * buffer.numberOfChannels * 4 > 900 * 1024 * 1024) throw new Error('TRACK TOO LARGE TO DECODE IN MEMORY');
  const sr = buffer.sampleRate;
  const first = Math.max(0, Math.floor(from * sr));
  const last = Math.min(buffer.length, Math.ceil(to * sr));
  const step = sr; // one-second chunks
  for (let i = first; i < last; i += step) {
    if (signal.aborted) throw new ExportCancelledError();
    const n = Math.min(step, last - i);
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice(i, i + n));
    yield { channels, sampleRate: sr, firstFrame: i };
  }
}

export class RenderController {
  private readonly abort = new AbortController();

  constructor(
    private readonly job: RenderJob,
    private readonly onProgress: (p: RenderProgress) => void = () => {},
    private readonly onPreview: (canvas: HTMLCanvasElement) => void = () => {},
  ) {}

  cancel(): void {
    this.abort.abort();
  }

  get cancelled(): boolean {
    return this.abort.signal.aborted;
  }

  async run(): Promise<RenderResult> {
    const { spec, visual } = this.job;
    const signal = this.abort.signal;
    const disk = this.job.disk ?? null;
    const memory = disk ? null : new MemoryFileSink(this.job.memoryLimitBytes ?? MAX_IN_MEMORY_BYTES);
    const t0 = performance.now();
    const fps = spec.fps;
    const total = frameCount(spec.start, spec.end, fps);
    const preStart = preRollStart(spec.start);
    const preFrames = Math.round((spec.start - preStart) * fps);
    const written = () => (disk ? disk.bytes : (memory?.size ?? 0));
    const report = (phase: RenderPhase, frame: number) => {
      const elapsed = performance.now() - t0;
      const speed = frame > 0 ? frame / (elapsed / 1000) : 0;
      this.onProgress({ phase, frame, totalFrames: total, elapsedMs: elapsed, speed, etaMs: speed > 0 ? ((total - frame) / speed) * 1000 : 0, bytes: written() });
    };
    const checkCancel = () => {
      if (signal.aborted) throw new ExportCancelledError();
    };
    const checkMemory = () => {
      if (memory?.limitError) throw memory.limitError;
    };

    let engine: VisualizerEngine | null = null;
    let output: InstanceType<Mediabunny['Output']> | null = null;
    try {
      if (!(spec.end > spec.start)) throw new Error('EMPTY EXPORT RANGE');
      report('preparing', 0);
      const mb = await loadMediabunny();
      checkCancel();

      // ---- export canvas + engine (independent of the window size) ----------------------
      const canvas = document.createElement('canvas');
      canvas.width = spec.width;
      canvas.height = spec.height;
      engine = new VisualizerEngine(canvas, { quality: this.job.quality, preserveDrawingBuffer: true, sceneFade: 0 });
      engine.setSize(spec.width, spec.height, 1);
      const eng = engine;

      // ---- output -------------------------------------------------------------------------
      const info = containerInfo(spec.container);
      // Packets go to the sink as they are produced ('reserve' keeps the metadata at the
      // front without holding the media in memory), so the sink sees the real size.
      const sinkStream = (disk ? disk.stream : memory!.stream) as WritableStream;
      const target = new mb.StreamTarget(sinkStream, { chunked: true, chunkSize: disk ? DISK_CHUNK_BYTES : MEMORY_CHUNK_BYTES });
      const format =
        spec.container === 'webm'
          ? new mb.WebMOutputFormat()
          : spec.container === 'mov'
            ? new mb.MovOutputFormat({ fastStart: 'reserve' })
            : new mb.Mp4OutputFormat({ fastStart: 'reserve' });
      output = new mb.Output({ format, target });
      const videoSource = new mb.CanvasSource(canvas, {
        codec: spec.videoCodec,
        quality: new mb.Quality({ bitrate: spec.videoBitrate }),
        keyFrameInterval: 2,
        latencyMode: 'quality',
        sizeChangeBehavior: 'deny',
        hardwareAcceleration: spec.videoCodec === 'hevc' ? 'prefer-hardware' : 'no-preference',
      });
      const audioSource = new mb.AudioSampleSource({
        codec: spec.audioCodec,
        quality: new mb.Quality({ bitrate: spec.audioBitrate }),
        transform: { sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: 2 },
      });
      output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: total + 16 });
      output.addAudioTrack(audioSource, { maximumPacketCount: maxAudioPackets(spec.end - spec.start) });

      // ---- analysis: the live algorithm on decoded PCM -----------------------------------
      let ring: PcmRing | null = null;
      let setTime: (t: number) => void = () => {};
      const hub = new AnalysisHub();
      hub.setExportMode(true);
      hub.setTuning({
        bassSensitivity: 1,
        midSensitivity: 1,
        highSensitivity: 1,
        smoothing: typeof visual.params.smoothing === 'number' ? visual.params.smoothing : 0.45,
        beatImpact: 1,
        reducedMotion: this.job.reducedMotion,
        decay: typeof visual.params.decay === 'number' ? visual.params.decay : 1,
      });

      // the WASM AAC encoder's padding is trimmed by starting the audio track before 0
      const audioLead = spec.audioCodec === 'aac' && aacPolyfillActive() ? AAC_POLYFILL_PRIMING_FRAMES / AUDIO_SAMPLE_RATE : 0;

      let frame = -preFrames; // negative = pre-roll
      let nowMs = 1000;
      const step = 1000 / fps;

      const renderFrame = async (k: number) => {
        const t = frameTime(spec.start, k, fps);
        setTime(analysisTime(t, fps));
        nowMs += step;
        hub.tick(nowMs);
        // the last second of pre-roll is drawn so feedback effects (trails) are warm too
        const draw = k >= -fps;
        eng.render({ frame: hub.frame, time: t, dt: 1 / fps, visual, reducedMotion: this.job.reducedMotion, exporting: true, skipRender: !draw });
        if (k >= 0) {
          await videoSource.add(frameTimestamp(k, fps), 1 / fps);
          if (k % 15 === 0) {
            this.onPreview(canvas);
            report('rendering', k + 1);
          }
        }
        checkMemory();
      };

      await output.start();
      report('prerolling', 0);
      const startFrame = (sr: number) => Math.round(spec.start * sr);
      const endFrame = (sr: number) => Math.round(spec.end * sr);
      let decodedUntil = 0;
      let lastYield = performance.now();

      for await (const chunk of decodeAudio(mb, this.job.file, preStart, spec.end + 0.05, signal)) {
        const sr = chunk.sampleRate;
        if (!ring) {
          ring = new PcmRing(Math.ceil(sr * 8));
          const ve = virtualEngine(new PcmAnalyser(ring, sr, this.job.fftSize));
          setTime = ve.setTime;
          hub.attach(ve.engine);
          hub.setEventMap(this.job.eventMap);
        }
        // mono mix for analysis
        const n = chunk.channels[0].length;
        const mono = new Float32Array(n);
        for (const ch of chunk.channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / chunk.channels.length;
        ring.write(chunk.firstFrame, mono);

        // exact audio trim: only samples in [start, end), re-stamped from 0
        const a = Math.max(chunk.firstFrame, startFrame(sr));
        const b = Math.min(chunk.firstFrame + n, endFrame(sr));
        if (b > a) {
          const count = b - a;
          const planar = new Float32Array(count * chunk.channels.length);
          chunk.channels.forEach((ch, c) => planar.set(ch.subarray(a - chunk.firstFrame, b - chunk.firstFrame), c * count));
          const sample = new mb.AudioSample({
            data: planar,
            format: 'f32-planar',
            numberOfChannels: chunk.channels.length,
            sampleRate: sr,
            timestamp: (a - startFrame(sr)) / sr - audioLead,
          });
          try {
            await audioSource.add(sample);
          } finally {
            sample.close();
          }
        }
        decodedUntil = (chunk.firstFrame + n) / sr;

        // render every frame whose analysis window is fully decoded
        while (frame < total && analysisTime(frameTime(spec.start, frame, fps), fps) <= decodedUntil - 0.001) {
          checkCancel();
          if (frame === 0) report('rendering', 0);
          await renderFrame(frame);
          frame++;
          if (performance.now() - lastYield > 40) {
            lastYield = performance.now();
            await yieldNow();
          }
        }
      }
      if (!ring) throw new Error('THE FILE CONTAINS NO DECODABLE AUDIO');
      // frames past the last decoded sample (silence)
      while (frame < total) {
        checkCancel();
        await renderFrame(frame);
        frame++;
        if (performance.now() - lastYield > 40) {
          lastYield = performance.now();
          await yieldNow();
        }
      }

      // ---- finalize: still cancellable (the finished data is dropped afterwards) ---------
      checkCancel();
      report('finalizing', total);
      videoSource.close();
      audioSource.close();
      const mime = await output.getMimeType().catch((err: unknown) => {
        console.warn('[BEAT//FORM] could not read the codec string; using the plain MIME type', err);
        return info.mime;
      });
      await output.finalize();
      checkMemory();
      checkCancel();

      // ---- commit: the point of no return -------------------------------------------------
      if (disk) {
        report('saving', total);
        await disk.commit();
        return { blob: null, bytes: disk.bytes, mimeType: mime, frames: total, durationSeconds: total / fps, elapsedMs: performance.now() - t0 };
      }
      const blob = memory!.toBlob(info.mime);
      memory!.discard();
      return { blob, bytes: blob.size, mimeType: mime, frames: total, durationSeconds: total / fps, elapsedMs: performance.now() - t0 };
    } catch (err) {
      if (output) {
        try {
          await output.cancel();
        } catch (cancelErr) {
          console.warn('[BEAT//FORM] cancelling the muxer failed', cancelErr);
        }
      }
      memory?.discard();
      await disk?.abort(err);
      if (signal.aborted && disk?.state !== 'committed') throw new ExportCancelledError();
      throw err;
    } finally {
      engine?.dispose();
      engine?.renderer.forceContextLoss();
    }
  }
}

/**
 * The muxer hands data to the sink a chunk at a time (keeping at most two in flight), so the
 * chunk size bounds how far the counted size can lag behind: ≤ 512 KB in memory.
 */
const MEMORY_CHUNK_BYTES = 2 ** 18;
const DISK_CHUNK_BYTES = 2 ** 20;

/**
 * Upper bound of audio packets for 'reserve' fast start: AAC uses 1024 and Opus 960 samples
 * per packet at 48 kHz (≈ 47–50 per second); 100 per second plus a margin leaves headroom.
 */
export function maxAudioPackets(seconds: number): number {
  return Math.ceil((seconds + 2) * 100);
}

/**
 * Render one deterministic still at `time` (with the same pre-roll as an export) into
 * `target` — a true preview of the exported frame, independent of the live stage.
 */
export async function renderStill(
  job: Omit<RenderJob, 'disk' | 'memoryLimitBytes' | 'spec'> & { spec: Pick<ExportSpec, 'width' | 'height' | 'fps'> },
  time: number,
  target: HTMLCanvasElement,
): Promise<void> {
  const mb = await loadMediabunny();
  const { spec } = job;
  const canvas = document.createElement('canvas');
  const engine = new VisualizerEngine(canvas, { quality: job.quality, preserveDrawingBuffer: true, sceneFade: 0 });
  engine.setSize(spec.width, spec.height, 1);
  const hub = new AnalysisHub();
  hub.setExportMode(true);
  hub.setTuning({ bassSensitivity: 1, midSensitivity: 1, highSensitivity: 1, smoothing: Number(job.visual.params.smoothing ?? 0.45), beatImpact: 1, reducedMotion: job.reducedMotion, decay: Number(job.visual.params.decay ?? 1) });
  const fps = spec.fps;
  const from = preRollStart(time, 2);
  const frames = Math.max(1, Math.round((time - from) * fps));
  const abort = new AbortController();
  let ring: PcmRing | null = null;
  let setTime: (t: number) => void = () => {};
  try {
    for await (const chunk of decodeAudio(mb, job.file, from, time + 0.1, abort.signal)) {
      const sr = chunk.sampleRate;
      if (!ring) {
        ring = new PcmRing(Math.ceil(sr * 6));
        const analyser = new PcmAnalyser(ring, sr, job.fftSize);
        const ve = virtualEngine(analyser);
        setTime = ve.setTime;
        hub.attach(ve.engine);
        hub.setEventMap(job.eventMap);
      }
      const n = chunk.channels[0].length;
      const mono = new Float32Array(n);
      for (const ch of chunk.channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / chunk.channels.length;
      ring.write(chunk.firstFrame, mono);
    }
    let now = 1000;
    for (let k = 0; k <= frames; k++) {
      const t = from + k / fps;
      setTime(analysisTime(t, fps));
      now += 1000 / fps;
      hub.tick(now);
      engine.render({ frame: hub.frame, time: t, dt: 1 / fps, visual: job.visual, reducedMotion: job.reducedMotion, exporting: true, skipRender: k < frames - fps });
    }
    const g = target.getContext('2d');
    if (g) {
      g.fillStyle = '#000';
      g.fillRect(0, 0, target.width, target.height);
      g.drawImage(canvas, 0, 0, target.width, target.height);
    }
  } finally {
    engine.dispose();
    engine.renderer.forceContextLoss();
  }
}
