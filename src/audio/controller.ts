/**
 * Application-level audio controller: owns the engine, the pre-analyzer and the hub, and
 * translates between them and the UI stores. UI components call these functions only.
 */
import { analysisHub } from './analysis/AnalysisHub';
import { AnalysisAbortedError, MAX_ANALYSIS_SECONDS, PreAnalyzer } from './analysis/PreAnalyzer';
import { synthesizeTestPattern } from './dsp/testPattern';
import { encodeWav } from './dsp/wav';
import { AudioEngine, LoadCancelledError } from './engine/AudioEngine';
import { validateAudioFile } from './engine/fileValidation';
import { loadPlayerPrefs, savePlayerPrefs, usePlayer } from '../state/player';
import { resolveReducedMotion, useSettings, type VisualSettings } from '../state/settings';
import { useVisual } from '../state/visual';
import { useNotice } from '../state/notice';

export const engine = new AudioEngine();
const preAnalyzer = new PreAnalyzer();
analysisHub.attach(engine);

let analysisToken = 0;
/** The file currently loaded in the player (the offline video renderer reads it directly). */
let currentFile: File | null = null;

export function getCurrentFile(): File | null {
  return currentFile;
}
let systemReducedMotion = false;

// ---- engine → store ------------------------------------------------------------------
engine.on((e) => {
  switch (e.type) {
    case 'play':
      usePlayer.setState({ playing: true });
      break;
    case 'playing':
      usePlayer.setState({ playing: true, buffering: false });
      break;
    case 'pause':
      usePlayer.setState({ playing: false, lastSeek: engine.currentTime });
      break;
    case 'ended':
      usePlayer.setState({ playing: false, lastSeek: engine.currentTime });
      break;
    case 'waiting':
      usePlayer.setState({ buffering: true });
      break;
    case 'seeking':
      analysisHub.onSeek(e.time);
      usePlayer.setState({ lastSeek: e.time });
      break;
    case 'seeked':
      analysisHub.onSeek(e.time);
      break;
    case 'duration':
      usePlayer.setState((s) => ({ duration: e.duration, track: s.track ? { ...s.track, duration: e.duration } : s.track }));
      break;
    case 'volume':
      usePlayer.setState({ volume: e.volume, muted: e.muted });
      break;
    case 'context':
      usePlayer.setState({ contextState: e.state });
      break;
    case 'error':
      useNotice.getState().show(e.message);
      break;
  }
});

// ---- settings → engine / hub ------------------------------------------------------------
// The shared analysis runs neutral (sensitivity 1, impact 1); each scene applies its own
// audio-reaction settings on top (AudioFeatureProvider). Smoothing and decay shape the
// analysis itself, so they come from the active scene.
function applySettings(): void {
  const s: VisualSettings = useSettings.getState();
  const v = useVisual.getState();
  const params = v.scenes[v.sceneId]?.params ?? {};
  engine.setFftSize(s.fftSize);
  analysisHub.setTuning({
    bassSensitivity: 1,
    midSensitivity: 1,
    highSensitivity: 1,
    smoothing: typeof params.smoothing === 'number' ? params.smoothing : 0.45,
    beatImpact: 1,
    reducedMotion: resolveReducedMotion(s.reducedMotion, systemReducedMotion),
    decay: typeof params.decay === 'number' ? params.decay : 1,
  });
}

export function setSystemReducedMotion(value: boolean): void {
  systemReducedMotion = value;
  applySettings();
}

applySettings();
useSettings.subscribe(applySettings);
useVisual.subscribe(applySettings);

{
  const prefs = loadPlayerPrefs();
  engine.setVolume(prefs.volume);
  engine.setLoop(prefs.loop);
  usePlayer.setState({ volume: prefs.volume, loop: prefs.loop });
}

// ---- actions --------------------------------------------------------------------------
export async function loadFile(file: File): Promise<void> {
  const check = validateAudioFile(file);
  const hadTrack = usePlayer.getState().status === 'ready';
  if (!check.ok) {
    if (hadTrack) useNotice.getState().show(check.reason);
    else usePlayer.setState({ status: 'error', error: check.reason });
    return;
  }

  ++analysisToken;
  preAnalyzer.cancel();
  analysisHub.onTrackChange();
  usePlayer.setState({
    status: 'loading',
    error: null,
    playing: false,
    buffering: false,
    duration: 0,
    lastSeek: 0,
    track: { name: file.name, size: file.size, type: check.mime, extension: check.extension, duration: 0 },
    loadId: usePlayer.getState().loadId + 1,
    analysis: null,
    analysisStatus: 'idle',
    analysisProgress: 0,
    analysisMessage: null,
  });

  let duration = 0;
  try {
    duration = (await engine.load(file)).duration;
    currentFile = file;
  } catch (err) {
    if (err instanceof LoadCancelledError) return;
    currentFile = null;
    usePlayer.setState({ status: 'error', error: (err as Error).message, track: null });
    return;
  }
  usePlayer.setState((s) => ({
    status: 'ready',
    duration,
    track: s.track ? { ...s.track, duration } : s.track,
    sampleRate: engine.ctx?.sampleRate ?? 0,
  }));

  if (duration > MAX_ANALYSIS_SECONDS) {
    usePlayer.setState({ analysisStatus: 'unavailable', analysisMessage: `LONGER THAN ${MAX_ANALYSIS_SECONDS / 60} MIN — REAL-TIME DETECTION` });
    return;
  }
  void runPreAnalysis(file);
}

async function runPreAnalysis(file: File): Promise<void> {
  const token = ++analysisToken;
  let lastProgress = -1;
  usePlayer.setState({ analysisStatus: 'decoding', analysisProgress: 0 });
  try {
    const result = await preAnalyzer.analyze(
      file,
      (phase) => {
        if (token === analysisToken) usePlayer.setState({ analysisStatus: phase });
      },
      (p) => {
        const pct = Math.floor(p * 50) / 50; // ≤ 50 store updates per analysis
        if (token === analysisToken && pct !== lastProgress) {
          lastProgress = pct;
          usePlayer.setState({ analysisProgress: pct });
        }
      },
    );
    if (token !== analysisToken) return;
    analysisHub.setEventMap(result.events);
    usePlayer.setState({ analysisStatus: 'ready', analysis: result, analysisProgress: 1 });
  } catch (err) {
    if (err instanceof AnalysisAbortedError || token !== analysisToken) return;
    usePlayer.setState({ analysisStatus: 'unavailable', analysisMessage: (err as Error).message || 'PRE-ANALYSIS FAILED' });
  }
}

export function togglePlay(): void {
  if (usePlayer.getState().status !== 'ready') return;
  const r = engine.toggle();
  if (r) r.catch(() => {});
  usePlayer.setState({ contextState: engine.ctx?.state ?? 'none', sampleRate: engine.ctx?.sampleRate ?? 0 });
}

export function play(): void {
  if (usePlayer.getState().status !== 'ready') return;
  engine.play().catch(() => {});
  usePlayer.setState({ contextState: engine.ctx?.state ?? 'none', sampleRate: engine.ctx?.sampleRate ?? 0 });
}

export function pause(): void {
  engine.pause();
}

export function seek(time: number): void {
  if (usePlayer.getState().status !== 'ready') return;
  engine.seek(time);
}

export function seekBy(delta: number): void {
  seek(engine.currentTime + delta);
}

export function setVolume(volume: number): void {
  engine.setVolume(volume);
  if (volume > 0 && usePlayer.getState().muted) engine.setMuted(false);
  savePlayerPrefs(volume, usePlayer.getState().loop);
}

export function toggleMute(): void {
  engine.setMuted(!usePlayer.getState().muted);
}

export function toggleLoop(): void {
  const loop = !usePlayer.getState().loop;
  engine.setLoop(loop);
  usePlayer.setState({ loop });
  savePlayerPrefs(usePlayer.getState().volume, loop);
}

/** Render the built-in drum + bass pattern to a WAV file and load it like any upload. */
export async function loadTestPattern(): Promise<void> {
  const sr = 44100;
  const p = synthesizeTestPattern(sr, 120);
  const wav = encodeWav([p.samples, p.samples], sr);
  const file = new File([wav], 'beatform-test-pattern-120bpm.wav', { type: 'audio/wav', lastModified: 0 });
  await loadFile(file);
}

/** Free resources when the page goes away. */
export function disposeAudio(): void {
  ++analysisToken;
  preAnalyzer.cancel();
  engine.dispose();
}
