import { loadTestPattern } from '../audio/controller';
import { usePlayer } from '../state/player';
import { MODES, useSettings } from '../state/settings';
import { VisualStage } from '../visual/VisualStage';
import { formatTime, stripExtension } from './format';
import { Hud } from './Hud';

function HeroTitle({ onBrowse }: { onBrowse: () => void }) {
  const status = usePlayer((s) => s.status);
  const track = usePlayer((s) => s.track);
  const error = usePlayer((s) => s.error);
  const duration = usePlayer((s) => s.duration);

  if (track && status !== 'error') {
    const name = stripExtension(track.name).replace(/[_]+/g, ' ');
    const shown = name.length > 40 ? `${name.slice(0, 39)}…` : name;
    // long names get smaller type so they stay within two lines
    const k = Math.min(1, 15 / Math.max(1, shown.length));
    return (
      <div className="hero-title is-track">
        <span className="hero-kicker">
          [NOW] {track.extension.toUpperCase()} · {formatTime(duration)} · LOCAL FILE
        </span>
        <h1 className="hero-word hero-word-outline" title={track.name} style={{ ['--k' as string]: Math.max(0.42, k) }}>
          {shown}
        </h1>
      </div>
    );
  }

  return (
    <div className="hero-title">
      <button type="button" className="hero-cta" onClick={onBrowse} aria-describedby="hero-formats">
        <span className="hero-word">
          DROP YOUR
          <br />
          SOUND HERE
        </span>
      </button>
      <p id="hero-formats" className="hero-caption">
        [MP3 · WAV · FLAC · OGG · M4A] — CLICK OR DROP. DECODED AND ANALYSED IN YOUR BROWSER, NEVER UPLOADED.
        <button type="button" className="link-btn" onClick={() => void loadTestPattern()}>
          NO FILE? GENERATE A TEST PATTERN →
        </button>
      </p>
      {error && (
        <p className="hero-error" role="alert">
          ERROR — {error}
        </p>
      )}
    </div>
  );
}

function ModeSwitch() {
  const mode = useSettings((s) => s.mode);
  const set = useSettings((s) => s.set);
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Visual mode">
      {MODES.map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'is-on' : ''} onClick={() => set('mode', m.id)} title={`${m.name} (${Number(m.index)})`}>
          <span className="mode-index">MODE {m.index}</span>
          <span className="mode-name">{m.short}</span>
        </button>
      ))}
    </div>
  );
}

export function Hero({ onBrowse }: { onBrowse: () => void }) {
  return (
    <section className="hero" id="top" aria-label="Visualizer">
      <VisualStage />
      <div className="hero-frame" aria-hidden="true">
        <i className="cross tl" />
        <i className="cross tr" />
        <i className="cross bl" />
        <i className="cross br" />
        <span className="ruler ruler-l" />
        <span className="ruler ruler-r" />
      </div>
      <Hud />
      <HeroTitle onBrowse={onBrowse} />
      <ModeSwitch />
    </section>
  );
}
