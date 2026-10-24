import { useEffect, useMemo, useRef, useState } from 'react';
import { engine as audioEngine, getCurrentFile } from '../audio/controller';
import { formatBytes } from '../audio/engine/fileValidation';
import { qualityProfile } from '../engine/quality';
import type { PerformancePreset } from '../engine/types';
import { canStreamToDisk, checkVideo, hasWebCodecs, pickAudioBitrate, type Support } from '../export/capabilities';
import {
  ASPECT_LABELS,
  AUDIO_CODECS,
  CONTAINERS,
  FPS_OPTIONS,
  QUALITY_LEVELS,
  RESOLUTIONS,
  VIDEO_CODECS,
  audioBitrates,
  audioCodecFor,
  clampRange,
  rangeForTrack,
  codecsFor,
  estimateBytes,
  estimateMemoryBytes,
  frameCount,
  videoBitrate,
  type AspectId,
  type Container,
  type ExportFps,
  type ExportSpec,
  type QualityLevel,
  type VideoCodecId,
} from '../export/plan';
import type { RenderPhase } from '../export/RenderController';
import { cancelExport, discardResult, exportReducedMotion, onExportPreview, snapshotForExport, startExport, useStudio } from '../export/studio';
import { usePlayer } from '../state/player';
import { useSettings } from '../state/settings';
import { useUi } from '../state/ui';
import { useVisual } from '../state/visual';
import { ExportSection } from './ExportPanel';
import { formatTime } from './format';
import { CloseIcon } from './icons';
import { RangeSelector } from './RangeSelector';

function Seg<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="xs-field">
      <span className="set-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={value === o.value ? 'is-on' : ''}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const fmtRate = (bps: number) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MBPS` : `${Math.round(bps / 1000)} KBPS`);
const PHASE_LABELS: Record<RenderPhase, string> = {
  preparing: 'PREPARING',
  prerolling: 'PRE-ROLL',
  rendering: 'RENDERING',
  finalizing: 'FINALIZING',
  saving: 'SAVING',
};
const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}M ${String(s % 60).padStart(2, '0')}S` : `${s}S`;
};

export function ExportStudio() {
  const open = useUi((s) => s.exportOpen);
  const setOpen = useUi((s) => s.setExport);
  const setPreviewAspect = useUi((s) => s.setPreviewAspect);
  const duration = usePlayer((s) => s.duration);
  const playerStatus = usePlayer((s) => s.status);
  const analysis = usePlayer((s) => s.analysis);
  const track = usePlayer((s) => s.track);
  const loadId = usePlayer((s) => s.loadId);
  const accent = useVisual((s) => String(s.scenes[s.sceneId]?.params.primary ?? '#d4ff3a'));
  const studio = useStudio();

  const [container, setContainer] = useState<Container>('mp4');
  const [codec, setCodec] = useState<VideoCodecId>('avc');
  const [aspect, setAspect] = useState<AspectId>('16:9');
  const [resIndex, setResIndex] = useState(1);
  const [fps, setFps] = useState<ExportFps>(30);
  const [quality, setQuality] = useState<QualityLevel>('high');
  const [detail, setDetail] = useState<PerformancePreset>('quality');
  const [rangeMode, setRangeMode] = useState<'full' | 'segment'>('full');
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [toDisk, setToDisk] = useState(false);
  const [codecSupport, setCodecSupport] = useState<Record<string, Support | undefined>>({});
  const [fpsSupport, setFpsSupport] = useState<Record<number, Support | undefined>>({});
  const [resSupport, setResSupport] = useState<Record<number, Support | undefined>>({});
  const [audio, setAudio] = useState<{ bitrate: number; polyfill?: boolean } | null | undefined>(undefined);
  const [stillBusy, setStillBusy] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const resolutions = RESOLUTIONS[aspect];
  const res = resolutions[Math.min(resIndex, resolutions.length - 1)];
  const audioCodec = audioCodecFor(container);
  const videoBps = useMemo(() => videoBitrate(codec, res.width, res.height, fps, quality), [quality, res, fps, codec]);
  const span = rangeMode === 'full' ? { start: 0, end: duration } : clampRange(range.start, range.end, duration);
  const seconds = Math.max(0, span.end - span.start);

  // keep codec valid for the container
  useEffect(() => {
    if (!codecsFor(container).includes(codec)) setCodec(codecsFor(container)[0]);
  }, [container, codec]);
  // a selection belongs to one track: reset it when another file is loaded, clamp it to the
  // track otherwise (the export job is validated again in startExport)
  const rangeLoad = useRef(-1);
  useEffect(() => {
    const same = rangeLoad.current === loadId;
    rangeLoad.current = loadId;
    setRange((r) => rangeForTrack(r, same, duration));
  }, [loadId, duration]);

  // real capability checks for the current selection
  useEffect(() => {
    if (!open || !hasWebCodecs()) return;
    let alive = true;
    for (const c of codecsFor(container)) {
      checkVideo(c, res.width, res.height, fps, videoBps).then((s) => alive && setCodecSupport((m) => ({ ...m, [`${container}|${c}|${res.width}|${fps}`]: s })));
    }
    for (const f of FPS_OPTIONS) checkVideo(codec, res.width, res.height, f, videoBps).then((s) => alive && setFpsSupport((m) => ({ ...m, [f]: s })));
    resolutions.forEach((r, i) => {
      checkVideo(codec, r.width, r.height, fps, videoBps).then((s) => alive && setResSupport((m) => ({ ...m, [i]: s })));
    });
    setAudio(undefined);
    pickAudioBitrate(audioCodec, audioBitrates(audioCodec, quality)).then((a) => alive && setAudio(a));
    return () => {
      alive = false;
    };
  }, [open, container, codec, res.width, res.height, fps, videoBps, audioCodec, quality, resolutions]);

  // live preview of frames while rendering
  useEffect(
    () =>
      onExportPreview((c) => {
        const t = previewRef.current;
        const g = t?.getContext('2d');
        if (t && g) g.drawImage(c, 0, 0, t.width, t.height);
      }),
    [],
  );

  // match the live stage frame to the export aspect while the studio is open
  useEffect(() => {
    if (open) setPreviewAspect(aspect);
  }, [open, aspect, setPreviewAspect]);

  if (!open) return null;

  const busy = studio.status === 'running';
  const support = codecSupport[`${container}|${codec}|${res.width}|${fps}`];
  const videoOk = support?.ok === true;
  const audioOk = !!audio;
  const ready = playerStatus === 'ready' && !!getCurrentFile() && seconds >= 0.5 && videoOk && audioOk && !busy;
  const audioBps = audio?.bitrate ?? audioBitrates(audioCodec, quality)[0];
  const bytes = estimateBytes(videoBps, audioBps, seconds);
  const frames = frameCount(span.start, span.end, fps);
  const pw = 360;
  const ph = Math.round((pw * res.height) / res.width);
  const pScale = Math.min(1, 300 / ph);

  const spec = (): ExportSpec => ({
    container,
    videoCodec: codec,
    audioCodec,
    width: res.width,
    height: res.height,
    fps,
    quality,
    videoBitrate: videoBps,
    audioBitrate: audioBps,
    start: span.start,
    end: span.end,
  });

  const renderPreview = async () => {
    const file = getCurrentFile();
    const canvas = previewRef.current;
    if (!file || !canvas) return;
    setStillBusy(true);
    try {
      const { renderStill } = await import('../export/RenderController');
      await renderStill(
        {
          spec: { width: res.width, height: res.height, fps },
          file,
          eventMap: analysis?.events ?? null,
          visual: snapshotForExport(),
          quality: qualityProfile(detail),
          fftSize: useSettings.getState().fftSize,
          reducedMotion: exportReducedMotion(),
        },
        span.start + Math.min(2, seconds / 2),
        canvas,
      );
    } finally {
      setStillBusy(false);
    }
  };

  const p = studio.progress;
  const pct = p ? Math.min(1, p.frame / Math.max(1, p.totalFrames)) : 0;

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !busy && setOpen(false)}>
      <div className="modal studio" role="dialog" aria-modal="true" aria-label="Export studio" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>
            EXPORT STUDIO <span className="dim">· FRAME-BY-FRAME</span>
          </h2>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} disabled={busy} aria-label="Close export studio">
            <CloseIcon />
          </button>
        </header>

        {!hasWebCodecs() ? (
          <div className="studio-body">
            <p className="set-note">
              THIS BROWSER HAS NO WEBCODECS API, SO THE OFFLINE MP4 / MOV RENDERER IS UNAVAILABLE. USE A CURRENT CHROME OR EDGE ON DESKTOP. AS A FALLBACK
              YOU CAN RECORD THE LIVE STAGE IN REAL TIME AS WEBM:
            </p>
            <ExportSection />
          </div>
        ) : (
          <div className="studio-body">
            <div className="studio-preview">
              <canvas ref={previewRef} width={pw} height={ph} style={{ width: pw * pScale, height: ph * pScale }} className="studio-canvas" />
              <div className="studio-preview-meta">
                <span className="dim">
                  EXPORT FRAME · {res.width}×{res.height}
                </span>
                <button type="button" className="btn btn-mini" disabled={!getCurrentFile() || busy || stillBusy} onClick={() => void renderPreview()}>
                  {stillBusy ? 'RENDERING…' : 'RENDER PREVIEW FRAME'}
                </button>
              </div>
              {busy && p && (
                <div className="studio-progress" role="status">
                  <div className="studio-bar" style={{ ['--p' as string]: pct }} />
                  <span>
                    {PHASE_LABELS[p.phase]} · FRAME {p.frame} / {p.totalFrames}
                  </span>
                  <span className="dim">
                    {p.speed.toFixed(1)} FPS ({(p.speed / fps).toFixed(2)}× REALTIME) · {fmtDuration(p.elapsedMs)} ELAPSED · ~{fmtDuration(p.etaMs)} LEFT
                    {p.bytes > 0 ? ` · ${formatBytes(p.bytes)} ${toDisk ? 'WRITTEN (NOT SAVED YET)' : 'IN MEMORY'}` : ''}
                  </span>
                  {p.phase === 'saving' ? (
                    <span className="set-note">SAVING THE FINISHED FILE — THIS LAST STEP CANNOT BE CANCELLED</span>
                  ) : (
                    <button type="button" className="btn" onClick={cancelExport} disabled={studio.cancelRequested}>
                      {studio.cancelRequested ? (p.phase === 'finalizing' ? 'CANCELLING AFTER FINALIZING…' : 'CANCELLING…') : 'CANCEL'}
                    </button>
                  )}
                </div>
              )}
              {studio.status === 'done' && studio.result && (
                <div className="studio-result" role="status">
                  <strong>EXPORT READY</strong>
                  <span className="dim">
                    {studio.result.name} · {formatBytes(studio.result.bytes)} · {studio.result.frames} FRAMES · {studio.result.durationSeconds.toFixed(2)} S · RENDERED IN{' '}
                    {fmtDuration(studio.result.elapsedMs)}
                  </span>
                  <span className="dim">{studio.result.mimeType.toUpperCase()}</span>
                  {studio.result.url ? (
                    <a className="btn btn-primary" href={studio.result.url} download={studio.result.name}>
                      SAVE FILE
                    </a>
                  ) : (
                    <span>WRITTEN TO DISK</span>
                  )}
                  <button type="button" className="btn" onClick={discardResult}>
                    DISCARD
                  </button>
                </div>
              )}
              {studio.status === 'error' && <p className="hero-error">EXPORT FAILED — {studio.error}</p>}
              {studio.status === 'cancelled' && <p className="set-note">EXPORT CANCELLED. NOTHING WAS SAVED{toDisk ? ' — THE FILE ON DISK WAS LEFT AS IT WAS' : ''}.</p>}
            </div>

            <div className="studio-form">
              <Seg label="FORMAT" value={container} options={CONTAINERS.map((c) => ({ value: c.id, label: c.label, disabled: busy }))} onChange={setContainer} />
              <Seg
                label="VIDEO CODEC"
                value={codec}
                options={codecsFor(container).map((c) => {
                  const s = codecSupport[`${container}|${c}|${res.width}|${fps}`];
                  return { value: c, label: `${VIDEO_CODECS[c].label}${s && !s.ok ? ' ✕' : ''}`, disabled: busy || (s ? !s.ok : false), title: s?.reason };
                })}
                onChange={setCodec}
              />
              {support && !support.ok && <p className="set-note warn">{support.reason}. {codec === 'hevc' ? 'USE MP4 H.264 INSTEAD.' : ''}</p>}
              <Seg
                label="ASPECT RATIO"
                value={aspect}
                options={(Object.keys(RESOLUTIONS) as AspectId[]).map((a) => ({ value: a, label: ASPECT_LABELS[a], disabled: busy }))}
                onChange={(a) => {
                  setAspect(a);
                  setResIndex(Math.min(1, RESOLUTIONS[a].length - 1));
                }}
              />
              <Seg
                label="RESOLUTION"
                value={Math.min(resIndex, resolutions.length - 1)}
                options={resolutions.map((r, i) => {
                  const s = resSupport[i];
                  const hide = r.requiresCheck && !(s?.ok);
                  return { value: i, label: `${r.label}${hide ? (s ? ' ✕' : ' …') : ''}`, disabled: busy || (hide && !!s) || (r.requiresCheck && !s), title: s?.reason };
                })}
                onChange={setResIndex}
              />
              <Seg
                label="FRAME RATE"
                value={fps}
                options={FPS_OPTIONS.map((f) => ({ value: f, label: `${f}${fpsSupport[f] && !fpsSupport[f]!.ok ? ' ✕' : ''}`, disabled: busy || fpsSupport[f]?.ok === false, title: fpsSupport[f]?.reason }))}
                onChange={setFps}
              />
              <Seg label="QUALITY" value={quality} options={QUALITY_LEVELS.map((q) => ({ value: q.id, label: q.label, disabled: busy }))} onChange={setQuality} />
              <Seg
                label="RENDER DETAIL"
                value={detail}
                options={(['balanced', 'quality', 'ultra'] as PerformancePreset[]).map((d) => ({ value: d, label: d.toUpperCase(), disabled: busy }))}
                onChange={setDetail}
              />
              <div className="xs-field">
                <span className="set-label">AUDIO</span>
                <span className="xs-value">
                  {AUDIO_CODECS[audioCodec].label} · STEREO · 48 KHZ ·{' '}
                  {audio === undefined ? 'CHECKING…' : audio ? `${Math.round(audio.bitrate / 1000)} KBPS${audio.polyfill ? ' · WASM ENCODER' : ''}` : 'NOT SUPPORTED ON THIS DEVICE'}
                </span>
              </div>
              <Seg
                label="VIDEO RANGE"
                value={rangeMode}
                options={[
                  { value: 'full', label: 'FULL TRACK', disabled: busy },
                  { value: 'segment', label: 'SELECTED SEGMENT', disabled: busy },
                ]}
                onChange={setRangeMode}
              />
              {rangeMode === 'segment' && duration > 0 && (
                <div className="xs-range">
                  <RangeSelector duration={duration} start={range.start} end={range.end} analysis={analysis} accent={accent} onChange={(s, e) => setRange(clampRange(s, e, duration))} />
                  <div className="xs-range-tools">
                    <button type="button" className="btn btn-mini" disabled={busy} onClick={() => setRange(clampRange(audioEngine.currentTime, range.end, duration))}>
                      START = PLAYHEAD
                    </button>
                    <button type="button" className="btn btn-mini" disabled={busy} onClick={() => setRange(clampRange(range.start, audioEngine.currentTime, duration))}>
                      END = PLAYHEAD
                    </button>
                    {[15, 30, 60].map((len) => (
                      <button key={len} type="button" className="btn btn-mini" disabled={busy} onClick={() => setRange(clampRange(range.start, range.start + len, duration))}>
                        {len} S
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {canStreamToDisk() && (
                <div className="xs-field">
                  <span className="set-label">OUTPUT</span>
                  <div className="seg" role="radiogroup" aria-label="Output target">
                    <button type="button" role="radio" aria-checked={!toDisk} className={!toDisk ? 'is-on' : ''} disabled={busy} onClick={() => setToDisk(false)}>
                      IN MEMORY → DOWNLOAD
                    </button>
                    <button type="button" role="radio" aria-checked={toDisk} className={toDisk ? 'is-on' : ''} disabled={busy} onClick={() => setToDisk(true)}>
                      WRITE TO DISK
                    </button>
                  </div>
                </div>
              )}

              <dl className="xs-summary">
                <div>
                  <dt>DURATION</dt>
                  <dd>
                    {formatTime(seconds, true)} · {formatTime(span.start, true)} → {formatTime(span.end, true)}
                  </dd>
                </div>
                <div>
                  <dt>VIDEO</dt>
                  <dd>
                    {res.width}×{res.height} · {fps} FPS · {VIDEO_CODECS[codec].label} · ~{fmtRate(videoBps)} VBR
                  </dd>
                </div>
                <div>
                  <dt>CONTAINER</dt>
                  <dd>
                    .{CONTAINERS.find((c) => c.id === container)!.extension.toUpperCase()} · {AUDIO_CODECS[audioCodec].label}
                  </dd>
                </div>
                <div>
                  <dt>EST. SIZE</dt>
                  <dd>
                    ~{formatBytes(bytes)} · {frames} FRAMES
                  </dd>
                </div>
                <div>
                  <dt>RESOURCES</dt>
                  <dd>
                    {toDisk ? 'STREAMED TO DISK · ' : `~${formatBytes(estimateMemoryBytes(bytes, res.width, res.height))} RAM · `}
                    AUDIO DECODED AS A STREAM
                  </dd>
                </div>
              </dl>
              <p className="set-note dim">
                EVERY FRAME IS RENDERED AT EXACT TIME START + N / FPS, INDEPENDENT OF YOUR SCREEN AND FRAME RATE — SLOW MACHINES TAKE LONGER BUT DROP NOTHING.
                BITRATE-BASED ENCODING (WEBCODECS OFFERS NO CRF). THE TRACK NEVER LEAVES THIS DEVICE.
              </p>
              {track && (
                <button type="button" className="btn btn-primary btn-block" disabled={!ready} onClick={() => void startExport(spec(), detail, toDisk)}>
                  {busy ? 'RENDERING…' : `EXPORT ${CONTAINERS.find((c) => c.id === container)!.label} · ${res.width}×${res.height} · ${fps} FPS`}
                </button>
              )}
              {!track && <p className="set-note warn">LOAD AN AUDIO FILE TO EXPORT A VIDEO.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
