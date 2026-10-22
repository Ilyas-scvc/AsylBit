import { useMemo } from 'react';
import { cancelExport, discardExport, exportSupport, startExport } from '../export/exporter';
import { formatBytes } from '../audio/engine/fileValidation';
import { useExport, EXPORT_SIZES, type ExportAspect, type ExportFps } from '../state/exportState';
import { usePlayer } from '../state/player';
import { formatTime } from './format';

const ASPECTS: ExportAspect[] = ['16:9', '9:16', '1:1'];
const FPS: ExportFps[] = [30, 60];

/** Settings-panel section. Not rendered as a button at all when the browser cannot record. */
export function ExportSection() {
  const support = useMemo(exportSupport, []);
  const aspect = useExport((s) => s.aspect);
  const fps = useExport((s) => s.fps);
  const status = useExport((s) => s.status);
  const playerStatus = usePlayer((s) => s.status);
  const duration = usePlayer((s) => s.duration);
  const busy = status === 'preparing' || status === 'recording' || status === 'finalizing';

  if (!support.ok) {
    return (
      <p className="set-note">
        VIDEO EXPORT UNAVAILABLE — {support.reason}. TRY A CURRENT CHROME, EDGE OR FIREFOX.
      </p>
    );
  }
  const [w, h] = EXPORT_SIZES[aspect];
  return (
    <>
      <div className="set-row set-row-seg">
        <span className="set-label">FRAME</span>
        <div className="seg" role="radiogroup" aria-label="Export frame">
          {ASPECTS.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={aspect === a} className={aspect === a ? 'is-on' : ''} onClick={() => useExport.setState({ aspect: a })} disabled={busy}>
              {a}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row set-row-seg">
        <span className="set-label">FRAME RATE</span>
        <div className="seg" role="radiogroup" aria-label="Export frame rate">
          {FPS.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={fps === f} className={fps === f ? 'is-on' : ''} onClick={() => useExport.setState({ fps: f })} disabled={busy}>
              {f} FPS
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="btn btn-primary btn-block" disabled={playerStatus !== 'ready' || busy} onClick={() => void startExport(aspect, fps)}>
        {busy ? 'RECORDING…' : `RECORD ${w}×${h} WEBM`}
      </button>
      <p className="set-note dim">
        RECORDS IN REAL TIME FROM 00:00{duration ? ` (${formatTime(duration)})` : ''}, WITH THE ORIGINAL AUDIO. KEEP THE TAB VISIBLE. {support.mime?.includes('vp9') ? 'VP9' : 'VP8'} + OPUS · WEBM ONLY.
      </p>
    </>
  );
}

/** Floating status while recording, and the result afterwards. */
export function ExportStatusBar() {
  const status = useExport((s) => s.status);
  const progress = useExport((s) => s.progress);
  const result = useExport((s) => s.result);
  const error = useExport((s) => s.error);
  const aspect = useExport((s) => s.aspect);
  const fps = useExport((s) => s.fps);
  const duration = usePlayer((s) => s.duration);

  if (status === 'idle') return null;
  if (status === 'error') {
    return (
      <div className="export-bar is-error" role="alert">
        <span>EXPORT FAILED — {error}</span>
        <button type="button" className="btn" onClick={() => useExport.setState({ status: 'idle', error: null })}>
          DISMISS
        </button>
      </div>
    );
  }
  if (status === 'done' && result) {
    return (
      <div className="export-bar" role="status">
        <span>
          EXPORT READY · {result.width}×{result.height} · {formatBytes(result.size)}
        </span>
        <a className="btn btn-primary" href={result.url} download={result.name}>
          SAVE .WEBM
        </a>
        <button type="button" className="btn" onClick={discardExport}>
          DISCARD
        </button>
      </div>
    );
  }
  const [w, h] = EXPORT_SIZES[aspect];
  return (
    <div className="export-bar is-rec" role="status" style={{ ['--p' as string]: progress }}>
      <span className="rec-dot" />
      <span>
        {status === 'preparing' ? 'PREPARING' : status === 'finalizing' ? 'FINALIZING' : 'REC'} {formatTime(progress * duration)} / {formatTime(duration)} · {w}×{h} · {fps} FPS — KEEP THIS TAB VISIBLE
      </span>
      <button type="button" className="btn" onClick={cancelExport} disabled={status !== 'recording'}>
        CANCEL
      </button>
    </div>
  );
}
