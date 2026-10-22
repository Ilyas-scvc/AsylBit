/**
 * Playback engine.
 *
 * Graph (built once, the first time audio is needed):
 *
 *   HTMLAudioElement → MediaElementAudioSourceNode → AnalyserNode → GainNode (volume) → destination
 *                                                                 ↘ MediaStreamDestination (video export, on demand)
 *
 * The analyser sits before the volume control so the visuals do not depend on the
 * listening volume. One element and one source node live for the whole session; loading a
 * new file only swaps the element's `src`, so audio can never play twice.
 */
import { PlaybackClock } from './PlaybackClock';

export type EngineEvent =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'ended' }
  | { type: 'seeking'; time: number }
  | { type: 'seeked'; time: number }
  | { type: 'duration'; duration: number }
  | { type: 'volume'; volume: number; muted: boolean }
  | { type: 'waiting' }
  | { type: 'playing' }
  | { type: 'error'; message: string }
  | { type: 'context'; state: AudioContextState };

export interface LoadedMedia {
  duration: number;
}

export class LoadCancelledError extends Error {
  constructor() {
    super('load cancelled');
    this.name = 'LoadCancelledError';
  }
}

export const FFT_SIZES = [1024, 2048, 4096, 8192] as const;

export function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 1:
      return 'LOADING WAS ABORTED';
    case 2:
      return 'NETWORK ERROR WHILE READING THE FILE';
    case 3:
      return 'FILE IS CORRUPTED OR CANNOT BE DECODED';
    case 4:
      // browsers use this code both for unknown codecs and for undecodable data
      return 'CANNOT PLAY THIS FILE — UNSUPPORTED FORMAT OR CORRUPTED DATA';
    default:
      return 'UNKNOWN PLAYBACK ERROR';
  }
}

export class AudioEngine {
  readonly audio: HTMLAudioElement;
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private objectUrl: string | null = null;
  private loadToken = 0;
  private listeners = new Set<(e: EngineEvent) => void>();
  private pendingPlay: Promise<void> | null = null;
  private volume = 0.85;
  private muted = false;
  private fftSize = 2048;
  readonly clock = new PlaybackClock();

  constructor() {
    const audio = new Audio();
    audio.preload = 'auto';
    // volume is applied by the GainNode once the graph exists; keep the element at unity
    audio.volume = 1;
    this.audio = audio;

    audio.addEventListener('play', () => this.emit({ type: 'play' }));
    audio.addEventListener('playing', () => this.emit({ type: 'playing' }));
    audio.addEventListener('pause', () => this.emit({ type: 'pause' }));
    audio.addEventListener('ended', () => this.emit({ type: 'ended' }));
    audio.addEventListener('waiting', () => this.emit({ type: 'waiting' }));
    audio.addEventListener('seeking', () => {
      this.clock.reset(audio.currentTime, performance.now());
      this.emit({ type: 'seeking', time: audio.currentTime });
    });
    audio.addEventListener('seeked', () => {
      this.clock.reset(audio.currentTime, performance.now());
      this.emit({ type: 'seeked', time: audio.currentTime });
    });
    audio.addEventListener('durationchange', () => {
      if (Number.isFinite(audio.duration)) this.emit({ type: 'duration', duration: audio.duration });
    });
  }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Create the AudioContext and graph exactly once. Safe to call repeatedly. */
  ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    const source = ctx.createMediaElementSource(this.audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.fftSize;
    analyser.smoothingTimeConstant = 0; // smoothing happens in our own attack/release stage
    analyser.minDecibels = -120;
    analyser.maxDecibels = 0;
    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : this.volume;
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);
    ctx.addEventListener('statechange', () => this.emit({ type: 'context', state: ctx.state }));
    this.ctx = ctx;
    this.source = source;
    this.analyser = analyser;
    this.gain = gain;
    return ctx;
  }

  get hasSource(): boolean {
    return !!this.audio.currentSrc && this.objectUrl !== null;
  }

  get isPlaying(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  get duration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  get currentTime(): number {
    return this.audio.currentTime;
  }

  /** Smoothed playback position for the render loop. */
  readClock(): number {
    return this.clock.read(this.audio.currentTime, performance.now(), this.isPlaying && !this.audio.seeking, this.audio.playbackRate);
  }

  /**
   * Point the element at a new file. Resolves with metadata when the browser can play it,
   * rejects with a readable message otherwise. A newer load cancels an older one.
   */
  load(file: Blob): Promise<LoadedMedia> {
    const token = ++this.loadToken;
    this.pendingPlay = null;
    const audio = this.audio;
    if (!audio.paused) audio.pause();
    const previousUrl = this.objectUrl;
    const url = URL.createObjectURL(file);
    this.objectUrl = url;

    return new Promise<LoadedMedia>((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener('loadedmetadata', onMeta);
        audio.removeEventListener('error', onError);
      };
      const onMeta = () => {
        cleanup();
        if (token !== this.loadToken) return reject(new LoadCancelledError());
        this.clock.reset(0, performance.now());
        resolve({ duration: this.duration });
      };
      const onError = () => {
        cleanup();
        if (token !== this.loadToken) return reject(new LoadCancelledError());
        const message = mediaErrorMessage(audio.error);
        this.releaseUrl();
        reject(new Error(message));
      };
      audio.addEventListener('loadedmetadata', onMeta);
      audio.addEventListener('error', onError);
      audio.src = url;
      audio.load();
      // release the previous file only after the element no longer references it
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    });
  }

  /** Remove the current file and free its object URL. */
  unload(): void {
    this.loadToken++;
    this.pendingPlay = null;
    const audio = this.audio;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this.releaseUrl();
  }

  private releaseUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /**
   * Start playback. Must be called from a user gesture the first time (autoplay policy):
   * the context is created / resumed synchronously inside the gesture before play().
   */
  async play(): Promise<void> {
    if (!this.objectUrl) return;
    if (this.pendingPlay) return this.pendingPlay;
    const ctx = this.ensureContext();
    const resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    const token = this.loadToken;
    const run = (async () => {
      try {
        await resume;
        if (token !== this.loadToken) return;
        if (this.audio.ended) this.audio.currentTime = 0;
        await this.audio.play();
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return; // paused / replaced meanwhile
        this.emit({ type: 'error', message: (err as DOMException)?.name === 'NotAllowedError' ? 'PLAYBACK BLOCKED — CLICK PLAY AGAIN' : 'PLAYBACK FAILED' });
        throw err;
      } finally {
        this.pendingPlay = null;
      }
    })();
    this.pendingPlay = run;
    return run;
  }

  pause(): void {
    this.audio.pause();
  }

  toggle(): Promise<void> | void {
    if (this.isPlaying || this.pendingPlay) {
      this.pendingPlay = null;
      this.pause();
      return;
    }
    return this.play();
  }

  seek(time: number): void {
    const d = this.duration;
    if (!d) return;
    // exact (not fastSeek) so the event cursor and the audio agree
    this.audio.currentTime = Math.min(Math.max(0, time), Math.max(0, d - 0.01));
  }

  setLoop(loop: boolean): void {
    this.audio.loop = loop;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.applyGain();
    this.emit({ type: 'volume', volume: this.volume, muted: this.muted });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
    this.emit({ type: 'volume', volume: this.volume, muted: this.muted });
  }

  private applyGain(): void {
    if (this.gain && this.ctx) {
      // short ramp avoids zipper clicks while dragging the slider
      const now = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, now, 0.015);
    }
  }

  setFftSize(size: number): void {
    this.fftSize = size;
    if (this.analyser) this.analyser.fftSize = size;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /**
   * Audio stream of the original signal (pre-volume) for recording. Created lazily and
   * reused; it is connected only while a recording needs it.
   */
  captureStream(): MediaStream {
    const ctx = this.ensureContext();
    if (!this.streamDest) this.streamDest = ctx.createMediaStreamDestination();
    this.analyser!.connect(this.streamDest);
    return this.streamDest.stream;
  }

  releaseCaptureStream(): void {
    if (this.streamDest && this.analyser) {
      try {
        this.analyser.disconnect(this.streamDest);
      } catch {
        /* already disconnected */
      }
    }
  }

  dispose(): void {
    this.unload();
    this.listeners.clear();
    this.source?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
    this.source = null;
  }
}
