import { EVENT_LABELS } from '../audio/dsp/events';
import { usePlayer } from '../state/player';
import { MODES, useSettings, type VisualMode } from '../state/settings';
import { formatDb, formatTime } from './format';

const MAPPINGS: Record<VisualMode, [string, string][]> = {
  pulse: [
    ['BASS', 'SCALE + LARGE LOBES'],
    ['KICK', 'SPRING IMPULSE + RIM'],
    ['MID', 'SURFACE FOLDING + FLOW'],
    ['HIGH', 'RIPPLE + PARTICLE SHELL'],
    ['SNARE', 'TRAVELLING RING'],
  ],
  radial: [
    ['FFT', '192 LOG-SPACED LINES'],
    ['LOWS', 'LONG, SLOW, HEAVY'],
    ['HIGHS', 'SHORT, FAST, LIGHT'],
    ['HISTORY', 'RECEDING TUNNEL'],
    ['HAT', 'PARTICLES FROM ITS BAND'],
  ],
  wave: [
    ['TIME', 'ROWS SCROLL AWAY'],
    ['BASS', 'BROAD SWELLS'],
    ['MID', 'BENDS THE GEOMETRY'],
    ['HIGH', 'FINE FAST RIPPLE'],
    ['CAMERA', 'SLOW DRIFT'],
  ],
};

function ModesIndex() {
  const mode = useSettings((s) => s.mode);
  const set = useSettings((s) => s.set);
  return (
    <section className="block" id="modes" aria-labelledby="modes-title">
      <header className="block-head">
        <span className="dim">02</span>
        <h2 id="modes-title">MODES</h2>
        <span className="dim">3 FORMS · ONE ANALYSIS ENGINE</span>
      </header>
      <ol className="mode-list">
        {MODES.map((m) => (
          <li key={m.id} className={mode === m.id ? 'is-on' : ''}>
            <span className="mode-file">[MODE {m.index}]</span>
            <h3 className="mode-big">{m.name.toLowerCase()}</h3>
            <dl className="mode-map">
              {MAPPINGS[m.id].map(([k, v]) => (
                <div key={k}>
                  <dt>[{k}]</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <a
              className="btn mode-select"
              href="#top"
              aria-pressed={mode === m.id}
              onClick={() => set('mode', m.id)}
            >
              {mode === m.id ? 'ACTIVE' : 'SELECT'} →
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
            <li>GAIN · VOLUME</li>
            <li>OUTPUT</li>
          </ol>
          <p>
            Band levels, a log-spaced spectrum and spectral flux are read from the analyser on every animation frame, normalised with an
            adaptive reference and smoothed with separate attack and release.
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
            held bass note is not read as a new kick. It is a heuristic on a finished mix — not true instrument separation. Until the map is
            ready, the same rules run causally in real time.
          </p>
        </div>
        <div className="dossier-wrap">
          <h3 className="dim">[C] TRACK DOSSIER</h3>
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
    ['1 2 3', 'MODE'],
    ['F', 'FULLSCREEN'],
    ['L', 'REPEAT'],
    ['M', 'MUTE'],
    ['S', 'SETTINGS'],
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
    <div className="below">
      <ModesIndex />
      <Signal />
      <Keys />
    </div>
  );
}
