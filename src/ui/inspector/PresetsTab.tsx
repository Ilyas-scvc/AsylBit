import { useRef, useState } from 'react';
import { BUILTIN_PRESETS } from '../../engine/presets/builtins';
import { SHARE_HASH_KEY, encodePresetForUrl, presetToJson, presetsFromJson, type VisualPreset } from '../../engine/presets/schema';
import { getScene } from '../../engine/scenes/registry';
import { useNotice } from '../../state/notice';
import { usePresets } from '../../state/presets';
import { useVisual } from '../../state/visual';

function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const slug = (s: string) => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'preset';

function PresetRow({ p, active, onLoad, user }: { p: VisualPreset; active: boolean; onLoad: () => void; user: boolean }) {
  const { rename, duplicate, remove } = usePresets.getState();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [confirm, setConfirm] = useState(false);
  const scene = getScene(p.sceneId);
  return (
    <li className={`preset ${active ? 'is-on' : ''}`}>
      {editing ? (
        <form
          className="preset-rename"
          onSubmit={(e) => {
            e.preventDefault();
            rename(p.id, name);
            setEditing(false);
          }}
        >
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Preset name" autoFocus />
          <button type="submit" className="btn btn-mini">
            OK
          </button>
        </form>
      ) : (
        <button type="button" className="preset-load" onClick={onLoad} title={`Load ${p.name}`}>
          <span className="dim">{scene.index}</span> {p.name}
          {p.modulations.length > 0 && <span className="mod-count">~{p.modulations.length}</span>}
          {p.post.length > 0 && <span className="dim"> · FX {p.post.length}</span>}
        </button>
      )}
      <span className="preset-actions">
        {user && !editing && (
          <button type="button" className="btn btn-mini" onClick={() => setEditing(true)}>
            RENAME
          </button>
        )}
        <button type="button" className="btn btn-mini" onClick={() => duplicate(p)} title="Duplicate into my presets">
          DUP
        </button>
        <button type="button" className="btn btn-mini" onClick={() => downloadText(`beatform-${slug(p.name)}.json`, presetToJson(p))} title="Export JSON">
          JSON
        </button>
        {user &&
          (confirm ? (
            <button type="button" className="btn btn-mini btn-danger" onClick={() => remove(p.id)}>
              DELETE?
            </button>
          ) : (
            <button type="button" className="btn btn-mini" onClick={() => setConfirm(true)} onBlur={() => setConfirm(false)}>
              DEL
            </button>
          ))}
      </span>
    </li>
  );
}

export function PresetsTab() {
  const user = usePresets((s) => s.user);
  const presetId = useVisual((s) => s.presetId);
  const presetName = useVisual((s) => s.presetName);
  const dirty = useVisual((s) => s.dirty);
  const loadPreset = useVisual((s) => s.loadPreset);
  const [name, setName] = useState('');
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const notice = useNotice((s) => s.show);
  const currentIsUser = user.some((p) => p.id === presetId);

  const saveNew = () => {
    const snap = useVisual.getState().snapshot(name.trim() || `${presetName ?? 'MY PRESET'}`);
    usePresets.getState().add(snap);
    useVisual.setState({ presetId: snap.id, presetName: snap.name, dirty: false });
    setName('');
    notice(`SAVED "${snap.name}"`);
  };

  const overwrite = () => {
    if (!presetId) return;
    const snap = useVisual.getState().snapshot(presetName ?? undefined);
    usePresets.getState().overwrite(presetId, snap);
    useVisual.setState({ dirty: false });
    notice(`UPDATED "${presetName}"`);
  };

  const share = async () => {
    try {
      const snap = useVisual.getState().snapshot(presetName ?? 'SHARED PRESET');
      const url = `${window.location.origin}${window.location.pathname}#${SHARE_HASH_KEY}=${encodePresetForUrl(snap)}`;
      setShareUrl(url);
      try {
        await navigator.clipboard.writeText(url);
        notice('SHARE LINK COPIED — CONTAINS SETTINGS ONLY, NEVER AUDIO');
      } catch {
        notice('COPY THE LINK BELOW');
      }
    } catch (err) {
      notice((err as Error).message);
    }
  };

  const importFile = async (file: File) => {
    const { presets, errors } = presetsFromJson(await file.text());
    if (presets.length) usePresets.getState().importMany(presets);
    notice(presets.length ? `IMPORTED ${presets.length} PRESET${presets.length > 1 ? 'S' : ''}${errors.length ? ` · ${errors.length} REJECTED` : ''}` : `IMPORT FAILED — ${errors[0] ?? 'NO PRESETS'}`);
  };

  return (
    <div className="ins-presets">
      <section className="set-section">
        <h3>
          <span className="dim">[NOW]</span> {presetName ?? 'UNSAVED LOOK'}
          {dirty && <span className="dim"> · EDITED</span>}
        </h3>
        <form
          className="preset-save"
          onSubmit={(e) => {
            e.preventDefault();
            saveNew();
          }}
        >
          <input value={name} maxLength={60} placeholder="NAME…" onChange={(e) => setName(e.target.value)} aria-label="New preset name" />
          <button type="submit" className="btn btn-primary btn-mini">
            SAVE NEW
          </button>
        </form>
        <div className="preset-tools">
          {currentIsUser && dirty && (
            <button type="button" className="btn btn-mini" onClick={overwrite}>
              OVERWRITE
            </button>
          )}
          <button type="button" className="btn btn-mini" onClick={() => void share()}>
            SHARE LINK
          </button>
          <button type="button" className="btn btn-mini" onClick={() => downloadText('beatform-current.json', presetToJson(useVisual.getState().snapshot(presetName ?? undefined)))}>
            EXPORT JSON
          </button>
          <button type="button" className="btn btn-mini" onClick={() => fileRef.current?.click()}>
            IMPORT JSON
          </button>
          {user.length > 0 && (
            <button type="button" className="btn btn-mini" onClick={() => downloadText('beatform-presets.json', presetToJson(user))}>
              EXPORT ALL
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importFile(f);
            }}
          />
        </div>
        {shareUrl && <input className="share-url" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />}
      </section>
      <section className="set-section">
        <h3>
          <span className="dim">[01]</span> MY PRESETS · {user.length}
        </h3>
        {user.length === 0 ? (
          <p className="dossier-empty dim">NOTHING SAVED YET. PRESETS STAY IN THIS BROWSER.</p>
        ) : (
          <ul className="preset-list">
            {user.map((p) => (
              <PresetRow key={p.id} p={p} user active={p.id === presetId} onLoad={() => loadPreset(p)} />
            ))}
          </ul>
        )}
      </section>
      <section className="set-section">
        <h3>
          <span className="dim">[02]</span> BUILT-IN · {BUILTIN_PRESETS.length}
        </h3>
        <ul className="preset-list">
          {BUILTIN_PRESETS.map((p) => (
            <PresetRow key={p.id} p={p} user={false} active={p.id === presetId} onLoad={() => loadPreset(p)} />
          ))}
        </ul>
      </section>
    </div>
  );
}
