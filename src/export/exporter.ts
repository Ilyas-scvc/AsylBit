/**
 * Video export (WebM): records the visualizer canvas together with the original audio.
 *
 *   canvas.captureStream(fps)  ─┐
 *                               ├─ MediaStream → MediaRecorder (VP9/VP8 + Opus) → .webm
 *   Analyser → MediaStreamDest ─┘   (the decoded file itself — never the microphone)
 *
 * Recording runs in real time: the track plays once from the start while the canvas is
 * rendered at the exact export resolution. MP4 is deliberately not offered: browsers do
 * not reliably produce it through MediaRecorder.
 */
import fixWebmDuration from 'fix-webm-duration';
import { analysisHub } from '../audio/analysis/AnalysisHub';
import { engine } from '../audio/controller';
import { usePlayer } from '../state/player';
import { EXPORT_SIZES, useExport, type ExportAspect, type ExportFps } from '../state/exportState';
import { getStageCanvas, useRuntime } from '../visual/runtime';
import { stripExtension } from '../ui/format';

const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export interface ExportSupport {
  ok: boolean;
  mime: string | null;
  reason: string | null;
}

export function exportSupport(): ExportSupport {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return { ok: false, mime: null, reason: 'MEDIARECORDER IS NOT AVAILABLE IN THIS BROWSER' };
  }
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    return { ok: false, mime: null, reason: 'CANVAS CAPTURE IS NOT AVAILABLE IN THIS BROWSER' };
  }
  const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
  if (!mime) return { ok: false, mime: null, reason: 'THIS BROWSER CANNOT RECORD WEBM VIDEO' };
  return { ok: true, mime, reason: null };
}

interface Session {
  cancelled: boolean;
  finish: () => void;
}

let session: Session | null = null;

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

function seekTo(time: number): Promise<void> {
  return new Promise((resolve) => {
    const audio = engine.audio;
    if (Math.abs(audio.currentTime - time) < 1e-3) return resolve();
    audio.addEventListener('seeked', () => resolve(), { once: true });
    engine.seek(time);
  });
}

export async function startExport(aspect: ExportAspect, fps: ExportFps): Promise<void> {
  const support = exportSupport();
  if (!support.ok || !support.mime) {
    useExport.setState({ status: 'error', error: support.reason });
    return;
  }
  const player = usePlayer.getState();
  if (player.status !== 'ready' || !player.track || session) return;

  discardExport();
  const [width, height] = EXPORT_SIZES[aspect];
  useExport.setState({ status: 'preparing', progress: 0, error: null, aspect, fps });

  const wasLoop = engine.audio.loop;
  engine.pause();
  engine.setLoop(false);
  analysisHub.setExportMode(true);
  useRuntime.setState({ exportConfig: { width, height, fps } });

  const tracks: MediaStreamTrack[] = [];
  let recorder: MediaRecorder | null = null;
  const cleanup = () => {
    tracks.forEach((t) => t.stop());
    engine.releaseCaptureStream();
    engine.setLoop(wasLoop);
    analysisHub.setExportMode(false);
    useRuntime.setState({ exportConfig: null });
    engine.audio.removeEventListener('pause', onPause);
    engine.audio.removeEventListener('play', onPlay);
    engine.audio.removeEventListener('ended', onEnded);
    session = null;
  };
  const onEnded = () => session?.finish();
  // active recording time, used to write the duration into the WebM header
  let recordedMs = 0;
  let segmentStart = 0;
  const onPause = () => {
    if (recorder?.state === 'recording' && !engine.audio.ended) {
      recorder.pause();
      recordedMs += performance.now() - segmentStart;
    }
  };
  const onPlay = () => {
    if (recorder?.state === 'paused') {
      recorder.resume();
      segmentStart = performance.now();
    }
  };

  try {
    // let the stage re-layout and render a few frames at the export size
    await frames(4);
    const canvas = getStageCanvas();
    if (!canvas) throw new Error('NO CANVAS TO RECORD');
    if (canvas.width !== width || canvas.height !== height) await frames(4);
    await seekTo(0);

    const video = canvas.captureStream(fps);
    const audio = engine.captureStream();
    tracks.push(...video.getVideoTracks());
    const stream = new MediaStream([...video.getVideoTracks(), ...audio.getAudioTracks()]);
    recorder = new MediaRecorder(stream, {
      mimeType: support.mime,
      videoBitsPerSecond: fps === 60 ? 16_000_000 : 10_000_000,
      audioBitsPerSecond: 192_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => (recorder!.onstop = () => resolve()));

    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    session = { cancelled: false, finish };
    const current = session;
    engine.audio.addEventListener('ended', onEnded);
    engine.audio.addEventListener('pause', onPause);
    engine.audio.addEventListener('play', onPlay);

    recorder.start(1000);
    segmentStart = performance.now();
    await engine.play();
    useExport.setState({ status: 'recording' });
    const progressTimer = window.setInterval(() => {
      const d = engine.duration;
      if (d > 0) useExport.setState({ progress: Math.min(1, engine.currentTime / d) });
    }, 250);

    await done;
    window.clearInterval(progressTimer);
    useExport.setState({ status: 'finalizing', progress: 1 });
    if (recorder.state === 'recording') recordedMs += performance.now() - segmentStart;
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    engine.pause();
    cleanup();

    if (current.cancelled) {
      useExport.setState({ status: 'idle', progress: 0 });
      return;
    }
    const type = support.mime.split(';')[0];
    // MediaRecorder writes WebM without a duration, which breaks seeking in many players
    const raw = new Blob(chunks, { type });
    let blob = raw;
    try {
      blob = await fixWebmDuration(raw, Math.round(recordedMs), { logger: false });
    } catch {
      /* keep the unpatched file: still playable, just not seekable everywhere */
    }
    const base = stripExtension(player.track.name).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'track';
    useExport.setState({
      status: 'done',
      result: {
        url: URL.createObjectURL(blob),
        name: `beatform-${base}-${aspect.replace(':', 'x')}-${fps}fps.webm`,
        size: blob.size,
        mime: type,
        width,
        height,
      },
    });
  } catch (err) {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    engine.pause();
    cleanup();
    useExport.setState({ status: 'error', error: err instanceof Error ? err.message.toUpperCase() : 'EXPORT FAILED' });
  }
}

export function cancelExport(): void {
  if (!session) return;
  session.cancelled = true;
  session.finish();
}

/** Free the last exported file. */
export function discardExport(): void {
  const r = useExport.getState().result;
  if (r) URL.revokeObjectURL(r.url);
  useExport.setState({ result: null, status: useExport.getState().status === 'done' ? 'idle' : useExport.getState().status });
}
