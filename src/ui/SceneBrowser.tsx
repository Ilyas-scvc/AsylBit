import { useEffect, useRef, useState } from 'react';
import { sceneRegistry } from '../engine/scenes/registry';
import { SCENE_CATEGORIES, type SceneCategory } from '../engine/types';
import { useUi } from '../state/ui';
import { selectScene, useVisual } from '../state/visual';
import { CloseIcon } from './icons';
import { getThumbnail, renderThumbnails } from './thumbnails';

export function SceneBrowser() {
  const open = useUi((s) => s.browserOpen);
  const setOpen = useUi((s) => s.setBrowser);
  const sceneId = useVisual((s) => s.sceneId);
  const [filter, setFilter] = useState<SceneCategory | 'all'>('all');
  const [, setTick] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus({ preventScroll: true });
    let alive = true;
    renderThumbnails()
      .then(() => alive && setTick((t) => t + 1))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;
  const scenes = sceneRegistry.list(filter === 'all' ? undefined : filter);

  const pick = (id: string) => {
    selectScene(id);
    setOpen(false);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
      <div className="modal browser" role="dialog" aria-modal="true" aria-label="Scene browser" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>
            SCENES <span className="dim">· {sceneRegistry.size}</span>
          </h2>
          <div className="seg seg-compact" role="radiogroup" aria-label="Category">
            <button type="button" role="radio" aria-checked={filter === 'all'} className={filter === 'all' ? 'is-on' : ''} onClick={() => setFilter('all')}>
              ALL
            </button>
            {SCENE_CATEGORIES.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={filter === c.id} className={filter === c.id ? 'is-on' : ''} onClick={() => setFilter(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
          <button ref={closeRef} type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close scene browser">
            <CloseIcon />
          </button>
        </header>
        <ul className="scene-grid">
          {scenes.map((s) => {
            const thumb = getThumbnail(s.id);
            return (
              <li key={s.id}>
                <button type="button" className={`scene-card ${s.id === sceneId ? 'is-on' : ''}`} onClick={() => pick(s.id)}>
                  <span className="scene-thumb">{thumb ? <img src={thumb} alt="" /> : <span className="dim">RENDERING…</span>}</span>
                  <span className="scene-meta">
                    <span className="dim">
                      SCENE {s.index} · {s.category.toUpperCase()}
                    </span>
                    <strong>{s.name}</strong>
                    <span className="dim">{s.description}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {scenes.length === 0 && <li className="dim">NO SCENES IN THIS CATEGORY YET.</li>}
        </ul>
      </div>
    </div>
  );
}
