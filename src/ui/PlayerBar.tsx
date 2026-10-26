import { useEffect, useRef } from 'react';
import { engine, loadTestPattern, setVolume, toggleLoop, toggleMute, togglePlay } from '../audio/controller';
import { usePlayer } from '../state/player';
import { useNotice } from '../state/notice';
import { mappedStatus, playerSubLabel, playerTitle, timeLabels } from '../overlay/model';
import { ExitFullscreenIcon, FullscreenIcon, LoopIcon, PauseIcon, PlayIcon, UploadIcon, VolumeIcon } from './icons';
import { Timeline } from './Timeline';

export interface PlayerBarProps {
  onBrowse: () => void;
  onToggleFullscreen: () => void;
  isFullscreen: boolean;
  fullscreenSupported: boolean;
}

function LiveTime() {
  const ref = useRef<HTMLSpanElement>(null);
  const duration = usePlayer((s) => s.duration);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const text = timeLabels(engine.currentTime, 0).now;
      if (text !== last && ref.current) {
        last = text;
        ref.current.textContent = text;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span className="player-time" aria-label="Current time / duration">
      <span ref={ref}>00:00.0</span>
      <span className="dim">{timeLabels(0, duration).total}</span>
    </span>
  );
}

function AnalysisLine() {
  const track = usePlayer((s) => s.track);
  const sampleRate = usePlayer((s) => s.sampleRate);
  const analysisStatus = usePlayer((s) => s.analysisStatus);
  const progress = usePlayer((s) => s.analysisProgress);
  const analysis = usePlayer((s) => s.analysis);
  if (!track) return null;
  let state: string | null = null;
  if (analysisStatus === 'decoding') state = 'DECODING';
  else if (analysisStatus === 'analyzing') state = `ANALYZING ${Math.round(progress * 100)}%`;
  else if (analysisStatus === 'ready' && analysis) state = mappedStatus(analysis.counts);
  else if (analysisStatus === 'unavailable') state = 'REAL-TIME ONLY';
  return <span className="player-sub">{playerSubLabel(track.extension, track.size, sampleRate, state)}</span>;
}

export function PlayerBar({ onBrowse, onToggleFullscreen, isFullscreen, fullscreenSupported }: PlayerBarProps) {
  const status = usePlayer((s) => s.status);
  const track = usePlayer((s) => s.track);
  const playing = usePlayer((s) => s.playing);
  const loop = usePlayer((s) => s.loop);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const notice = useNotice((s) => s.message);
  const ready = status === 'ready';

  if (status === 'empty' || (status === 'error' && !track)) {
    return (
      <div className="player player-empty" role="region" aria-label="Player">
        <span className="player-nosignal">
          <i /> NO SIGNAL
        </span>
        <span className="player-hint">DROP AN AUDIO FILE ANYWHERE ON THE PAGE</span>
        <div className="player-empty-actions">
          <button type="button" className="btn btn-primary" onClick={onBrowse}>
            <UploadIcon /> BROWSE FILE
          </button>
          <button type="button" className="btn" onClick={() => void loadTestPattern()}>
            TEST PATTERN
          </button>
        </div>
        {notice && <div className="player-notice" role="alert">{notice}</div>}
      </div>
    );
  }

  return (
    <div className="player" role="region" aria-label="Player">
      <button
        type="button"
        className={`player-play ${playing ? 'is-playing' : ''}`}
        onClick={togglePlay}
        disabled={!ready}
        aria-label={playing ? 'Pause' : 'Play'}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="player-meta">
        <span className="player-title" title={track?.name}>
          {status === 'loading' ? 'LOADING…' : track ? playerTitle(track.name) : '—'}
        </span>
        <AnalysisLine />
      </div>
      <div className="player-timeline">
        <Timeline />
      </div>
      <LiveTime />
      <div className="player-controls">
        <div className="player-volume">
          <button type="button" className="icon-btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} title="Mute (M)">
            <VolumeIcon muted={muted || volume === 0} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label="Volume"
            style={{ ['--fill' as string]: muted ? 0 : volume }}
          />
        </div>
        <button type="button" className={`icon-btn ${loop ? 'is-on' : ''}`} onClick={toggleLoop} aria-pressed={loop} aria-label="Repeat" title="Repeat (L)">
          <LoopIcon />
        </button>
        <button type="button" className="icon-btn" onClick={onBrowse} aria-label="Replace file" title="Replace file">
          <UploadIcon />
        </button>
        {fullscreenSupported && (
          <button type="button" className="icon-btn" onClick={onToggleFullscreen} aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} title="Fullscreen (F)">
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
        )}
      </div>
      {notice && <div className="player-notice" role="alert">{notice}</div>}
    </div>
  );
}
