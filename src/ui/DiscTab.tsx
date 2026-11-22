/**
 * Inspector → DISC: the spinning disc's settings and its artwork (upload, replace, remove,
 * preview). The settings are global — the same disc on SCENE 10 and over other scenes.
 */
import { useEffect, useRef } from 'react';
import { DISC_GROUPS, DISC_PARAMS, DISC_SCENE_ID, discVisible } from '../engine/disc/settings';
import { loadArtwork, removeArtwork, restoreArtwork, useArtwork } from '../state/artwork';
import { useVisual } from '../state/visual';
import { ParamControl } from './inspector/ParamControl';

/** Bring back the artwork of the previous visit once, when the app starts. */
export function useArtworkRestore(): void {
  useEffect(() => {
    void restoreArtwork();
  }, []);
}

function ArtworkPanel() {
  const status = useArtwork((s) => s.status);
  const previewUrl = useArtwork((s) => s.previewUrl);
  const name = useArtwork((s) => s.name);
  const error = useArtwork((s) => s.error);
  const input = useRef<HTMLInputElement>(null);
  const has = !!previewUrl;

  return (
    <div className="art-panel">
      <div className={`art-preview ${has ? 'has-art' : ''}`}>
        {has ? <img src={previewUrl} alt={`Disc artwork: ${name ?? ''}`} /> : <span className="dim">NO ARTWORK — PROCEDURAL DISC</span>}
      </div>
      <div className="art-side">
        <div className="art-actions">
          <button type="button" className="btn btn-mini" onClick={() => input.current?.click()} disabled={status === 'loading'}>
            {has ? 'REPLACE' : 'UPLOAD'}
          </button>
          {has && (
            <button type="button" className="btn btn-mini" onClick={() => void removeArtwork()}>
              REMOVE
            </button>
          )}
        </div>
        <p className="set-note dim art-name" title={name ?? undefined}>
          {status === 'loading' ? 'LOADING…' : has ? name : 'PNG · JPEG · WEBP · GIF · AVIF · BMP, UP TO 30 MB. KEPT IN THIS BROWSER ONLY — NEVER IN PRESETS OR LINKS.'}
        </p>
        {error && (
          <p className="set-note art-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void loadArtwork(f);
        }}
      />
    </div>
  );
}

export function DiscTab() {
  const disc = useVisual((s) => s.disc);
  const sceneId = useVisual((s) => s.sceneId);
  const setDiscParam = useVisual((s) => s.setDiscParam);
  const resetDiscParam = useVisual((s) => s.resetDiscParam);
  const resetDisc = useVisual((s) => s.resetDisc);
  const toggleDisc = useVisual((s) => s.toggleDisc);
  const visible = discVisible(sceneId, disc);
  const state = visible ? 'ON SCREEN' : disc.enabled === false ? 'HIDDEN' : sceneId === DISC_SCENE_ID ? 'HIDDEN' : 'OFF ON THIS SCENE';

  return (
    <div className="ins-scene ins-disc">
      <div className="ins-scene-head">
        <span className="dim">SPINNING DISC</span>
        <strong>{state}</strong>
        <p className="dim">The CD of SCENE 10. ON ALL SCENES draws it over every scene; C (or TOGGLE DISC) shows / hides it. It is rendered into exported video too.</p>
        <div className="art-actions">
          <button type="button" className={`btn btn-mini ${visible ? 'is-on' : ''}`} aria-pressed={visible} onClick={toggleDisc}>
            TOGGLE DISC (C)
          </button>
          <button type="button" className="btn btn-mini" onClick={resetDisc}>
            RESET DISC
          </button>
        </div>
      </div>
      {DISC_GROUPS.map((g) => (
        <section className="set-section" key={g.id}>
          <h3>{g.label}</h3>
          {g.id === 'artwork' && <ArtworkPanel />}
          {DISC_PARAMS.filter((d) => d.group === g.id).map((d) => (
            <ParamControl key={d.key} def={d} value={disc[d.key] ?? d.default} onChange={(v) => setDiscParam(d.key, v)} onReset={() => resetDiscParam(d.key)} />
          ))}
        </section>
      ))}
    </div>
  );
}
