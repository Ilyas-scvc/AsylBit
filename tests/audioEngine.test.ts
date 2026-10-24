/**
 * AudioEngine play / pause intent with a slow AudioContext.resume(). The browser objects are
 * minimal stand-ins (no real audio) — they model only the parts the engine relies on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio/engine/AudioEngine';

class FakeAudio {
  paused = true;
  ended = false;
  seeking = false;
  currentTime = 0;
  duration = 30;
  playbackRate = 1;
  loop = false;
  volume = 1;
  preload = '';
  src = '';
  currentSrc = '';
  error = null;
  playCalls = 0;
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  load() {
    this.currentSrc = this.src;
    queueMicrotask(() => this.dispatch('loadedmetadata'));
  }
  removeAttribute() {
    this.src = '';
    this.currentSrc = '';
  }
  play() {
    this.playCalls++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

let audio: FakeAudio;
let resumes: { resolve: () => void }[];

class FakeAudioContext {
  state = 'suspended';
  sampleRate = 48000;
  currentTime = 0;
  outputLatency = 0;
  baseLatency = 0;
  destination = {};
  resume() {
    return new Promise<void>((resolve) => {
      resumes.push({
        resolve: () => {
          this.state = 'running';
          resolve();
        },
      });
    });
  }
  close() {
    return Promise.resolve();
  }
  addEventListener() {}
  createMediaElementSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return { fftSize: 2048, smoothingTimeConstant: 0, minDecibels: -100, maxDecibels: 0, connect() {}, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime() {} }, connect() {} };
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function loadedEngine(): Promise<AudioEngine> {
  const engine = new AudioEngine();
  await engine.load(new Blob([new Uint8Array(16)]));
  return engine;
}

beforeEach(() => {
  resumes = [];
  vi.stubGlobal(
    'Audio',
    class {
      constructor() {
        audio = new FakeAudio();
        return audio;
      }
    },
  );
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
});
afterEach(() => vi.unstubAllGlobals());

describe('AudioEngine — play intent while the AudioContext is resuming', () => {
  it('Play → Pause before resume completes: nothing starts', async () => {
    const engine = await loadedEngine();
    const p = engine.play();
    engine.pause();
    resumes[0].resolve();
    await p;
    await flush();
    expect(audio.playCalls).toBe(0);
    expect(engine.isPlaying).toBe(false);
  });

  it('Play → toggle (pause) before resume completes: nothing starts', async () => {
    const engine = await loadedEngine();
    const p = engine.play();
    engine.toggle();
    resumes[0].resolve();
    await p;
    await flush();
    expect(audio.playCalls).toBe(0);
  });

  it('Play → Pause → Play: exactly one start, and the newer request stays pending until it runs', async () => {
    const engine = await loadedEngine();
    const first = engine.play();
    engine.pause();
    const second = engine.play();
    for (const r of resumes) r.resolve();
    await Promise.all([first, second]);
    await flush();
    expect(audio.playCalls).toBe(1);
    expect(engine.isPlaying).toBe(true);
  });

  it('a stale play() never clears a newer pending play', async () => {
    const engine = await loadedEngine();
    const first = engine.play();
    engine.pause();
    const second = engine.play();
    resumes[0].resolve(); // the first (cancelled) request settles first
    await first;
    // the newer request is still pending: asking again must join it, not start a third
    const third = engine.play();
    for (const r of resumes) r.resolve();
    await Promise.all([second, third]);
    await flush();
    expect(audio.playCalls).toBe(1);
  });

  it('Play → Load (another file) before resume completes: the old request does not start the new file', async () => {
    const engine = await loadedEngine();
    const p = engine.play();
    const loading = engine.load(new Blob([new Uint8Array(8)]));
    resumes[0].resolve();
    await p;
    await loading;
    await flush();
    expect(audio.playCalls).toBe(0);
  });

  it('Play → Dispose before resume completes: nothing starts', async () => {
    const engine = await loadedEngine();
    const p = engine.play();
    engine.dispose();
    resumes[0].resolve();
    await p;
    await flush();
    expect(audio.playCalls).toBe(0);
  });

  it('a plain Play still starts playback', async () => {
    const engine = await loadedEngine();
    const p = engine.play();
    resumes[0].resolve();
    await p;
    expect(audio.playCalls).toBe(1);
    expect(engine.isPlaying).toBe(true);
  });
});
