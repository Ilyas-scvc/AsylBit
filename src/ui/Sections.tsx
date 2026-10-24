import { EVENT_LABELS } from '../audio/dsp/events';
import { sceneRegistry } from '../engine/scenes/registry';
import { usePlayer } from '../state/player';
import { useSettings } from '../state/settings';
import { selectScene, useVisual } from '../state/visual';
import { formatDb, formatTime } from './format';

function ScenesIndex() {
  const sceneId = useVisual((s) => s.sceneId);
  return (
    <section className="block" id="scenes" aria-labelledby="scenes-title">
      <header className="block-head">
        <span className="dim">02</span>
        <h2 id="scenes-title">SCENES</h2>
        <span className="dim">{sceneRegistry.size} FORMS · ONE ANALYSIS ENGINE</span>
      </header>
      <ol className="mode-list">
        {sceneRegistry.list().map((m) => (
          <li key={m.id} className={sceneId === m.id ? 'is-on' : ''}>
            <span className="mode-file">
              [SCENE {m.index}]<br />
              <span className="dim">{m.category.toUpperCase()}</span>
            </span>
            <h3 className="mode-big">{m.name.toLowerCase()}</h3>
            <dl className="mode-map">
              {m.mapping.map(([k, v]) => (
                <div key={k}>
                  <dt>[{k}]</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <a className="btn mode-select" href="#top" aria-pressed={sceneId === m.id} onClick={() => selectScene(m.id)}>
              {sceneId === m.id ? 'ACTIVE' : 'SELECT'} →
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Dossier() {
  const track = usePlayer((s) => s.track);
  const analysis = usePlayer((s) => s.analysis);
  const analysisStatus = usePlayer((s) => s.analysisStatus);
  const message = usePlayer((s) => s.analysisMessage);
  const sampleRate = usePlayer((s) => s.sampleRate);
  if (!track) {
    return <p className="dossier-empty dim">NO FILE LOADED. THE DOSSIER FILLS IN AFTER PRE-ANALYSIS.</p>;
  }
  const rows: [string, string][] = [
    ['FILE', track.name],
    ['LENGTH', formatTime(track.duration)],
    ['PLAYBACK RATE', sampleRate ? `${sampleRate} HZ` : 'AFTER FIRST PLAY'],
  ];
  if (analysis) {
    rows.push(
      ['PEAK', formatDb(analysis.peakDb)],
      ['RMS', formatDb(analysis.rmsDb)],
      ['ANALYSIS RATE', `${analysis.sampleRate} HZ · HOP ${(analysis.hop * 1000).toFixed(1)} MS`],
      ...analysis.counts.map((c, i) => [`${EVENT_LABELS[i]}S`, String(c)] as [string, string]),
      ['TEMPO (EST.)', analysis.bpm ? `≈${analysis.bpm} BPM · CONF ${(analysis.bpmConfidence * 100).toFixed(0)}%` : 'NOT STABLE ENOUGH'],
    );
  } else {
    rows.push(['ANALYSIS', analysisStatus === 'unavailable' ? message ?? 'UNAVAILABLE' : analysisStatus.toUpperCase()]);
  }
  return (
    <dl className="dossier">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>[{k}]</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Signal() {
  const fftSize = useSettings((s) => s.fftSize);
  return (
    <section className="block" id="signal" aria-labelledby="signal-title">
      <header className="block-head">
        <span className="dim">03</span>
        <h2 id="signal-title">SIGNAL</h2>
        <span className="dim">EVERYTHING STAYS IN THIS TAB</span>
      </header>
      <div className="signal-grid">
        <div className="chain">
          <h3 className="dim">[A] REAL-TIME PATH · EVERY FRAME</h3>
          <ol>
            <li>AUDIO ELEMENT</li>
            <li>MEDIA SOURCE</li>
            <li>ANALYSER · FFT {fftSize}</li>
            <li>SCENE AUDIO SETTINGS</li>
            <li>MODULATION</li>
            <li>SCENE + FX</li>
          </ol>
          <p>
            Band levels, a log-spaced spectrum and spectral flux are read from the analyser on every animation frame, normalised with an
            adaptive reference and smoothed with separate attack and release. Each scene then applies its own sensitivity, gate and impact,
            and any parameter can be bound to an audio source.
          </p>
          <h3 className="dim">[B] PRE-ANALYSIS · ONCE PER FILE, IN A WORKER</h3>
          <ol>
            <li>DECODE @ 22.05 KHZ</li>
            <li>FFT 1024 / HOP 256</li>
            <li>BAND FLUX + LEVEL RISE</li>
            <li>PEAK PICKING</li>
            <li>EVENT MAP</li>
          </ol>
          <p>
            Probable kicks, snares and hats are found by transients in separate bands, a real energy rise and minimum gaps between hits, so a
            held bass note is not read as a new kick. It is a heuristic on a finished mix — not true instrument separation.
          </p>
          <h3 className="dim">[C] VIDEO EXPORT · FRAME BY FRAME</h3>
          <ol>
            <li>STREAMED DECODE</li>
            <li>SAME ANALYSIS, OFFLINE</li>
            <li>FRAME N @ START + N/FPS</li>
            <li>WEBCODECS</li>
            <li>MP4 · MOV · WEBM</li>
          </ol>
          <p>
            Exports never record the screen: every frame is rendered at its exact music time on a dedicated canvas at the target resolution,
            encoded with the browser's own encoders and muxed with the original audio track.
          </p>
        </div>
        <div className="dossier-wrap">
          <h3 className="dim">[D] TRACK DOSSIER</h3>
          <Dossier />
        </div>
      </div>
    </section>
  );
}

function Keys() {
  const keys: [string, string][] = [
    ['SPACE', 'PLAY / PAUSE'],
    ['← →', 'SEEK 5 S'],
    ['1 … 9', 'SCENE'],
    ['[ ]', 'PREV / NEXT SCENE'],
    ['B', 'SCENE BROWSER'],
    ['S', 'INSPECTOR'],
    ['E', 'EXPORT STUDIO'],
    ['H', 'HIDE / SHOW UI'],
    ['ESC', 'SHOW UI · CLOSE PANEL'],
    ['F', 'FULLSCREEN'],
    ['L', 'REPEAT'],
    ['M', 'MUTE'],
  ];
  return (
    <footer className="block footer" id="keys" aria-labelledby="keys-title">
      <header className="block-head">
        <span className="dim">04</span>
        <h2 id="keys-title">KEYS</h2>
        <span className="dim">WHEN NO FIELD IS FOCUSED</span>
      </header>
      <dl className="keys">
        {keys.map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="colophon">
        <span className="logo">
          BEAT<span className="logo-slash">//</span>FORM
        </span>
        <span className="dim">LOCAL AUDIO ONLY · NO UPLOADS · NO TRACKING · {new Date().getFullYear()}</span>
      </div>
    </footer>
  );
}

export function Sections() {
  return (
    <div className="below chrome">
      <ScenesIndex />
      <Signal />
      <Keys />
    </div>
  );
}
