import { loadTestPattern } from '../audio/controller';
import { getScene } from '../engine/scenes/registry';
import { usePlayer } from '../state/player';
import { PREVIEW_ASPECTS, useUi } from '../state/ui';
import { stepScene, useVisual } from '../state/visual';
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

function SceneSwitch() {
  const sceneId = useVisual((s) => s.sceneId);
  const setBrowser = useUi((s) => s.setBrowser);
  const def = getScene(sceneId);
  return (
    <div className="scene-switch" role="group" aria-label="Scene">
      <button type="button" className="ss-step" onClick={() => stepScene(-1)} aria-label="Previous scene ([)">
        ‹
      </button>
      <button type="button" className="ss-name" onClick={() => setBrowser(true)} title="Open the scene browser (B)">
        <span className="mode-index">SCENE {def.index}</span>
        <span className="mode-name">{def.name}</span>
      </button>
      <button type="button" className="ss-step" onClick={() => stepScene(1)} aria-label="Next scene (])">
        ›
      </button>
    </div>
  );
}

function FrameSwitch() {
  const aspect = useUi((s) => s.previewAspect);
  const set = useUi((s) => s.setPreviewAspect);
  const safe = useUi((s) => s.safeZones);
  const toggleSafe = useUi((s) => s.toggleSafeZones);
  return (
    <div className="frame-switch" role="group" aria-label="Preview frame">
      <span className="dim">FRAME</span>
      {PREVIEW_ASPECTS.map((a) => (
        <button key={a.id} type="button" className={aspect === a.id ? 'is-on' : ''} aria-pressed={aspect === a.id} onClick={() => set(a.id)} title={a.id === 'full' ? 'Fill the window' : `Preview the ${a.id} export frame`}>
          {a.label}
        </button>
      ))}
      {aspect === '9:16' && (
        <button type="button" className={safe ? 'is-on' : ''} aria-pressed={safe} onClick={toggleSafe} title="Show Shorts / Reels / TikTok safe zones">
          SAFE
        </button>
      )}
    </div>
  );
}

export function Hero({ onBrowse }: { onBrowse: () => void }) {
  return (
    <section className="hero" id="top" aria-label="Visualizer">
      <VisualStage />
      <div className="hero-frame chrome" aria-hidden="true">
        <i className="cross tl" />
        <i className="cross tr" />
        <i className="cross bl" />
        <i className="cross br" />
        <span className="ruler ruler-l" />
        <span className="ruler ruler-r" />
      </div>
      <Hud />
      <HeroTitle onBrowse={onBrowse} />
      <div className="hero-controls chrome">
        <FrameSwitch />
        <SceneSwitch />
      </div>
    </section>
  );
}
