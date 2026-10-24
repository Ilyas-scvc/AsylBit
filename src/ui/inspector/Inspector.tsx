import { useEffect, useMemo, useRef, useState } from 'react';
import { getSceneSchema, PARAM_GROUPS } from '../../engine/params';
import { EFFECT_MAP, EFFECTS, effectStatus, fxTarget, MAX_TRAILS, type EffectType } from '../../engine/post/effects';
import { getScene } from '../../engine/scenes/registry';
import { useSettings } from '../../state/settings';
import { useUi, type InspectorTab } from '../../state/ui';
import { defaultSceneState, useVisual } from '../../state/visual';
import { CloseIcon } from '../icons';
import { ParamControl } from './ParamControl';
import { PresetsTab } from './PresetsTab';
import { SystemTab } from './SystemTab';
import { liveProfile, useRuntime } from '../../visual/runtime';

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'scene', label: 'SCENE' },
  { id: 'fx', label: 'FX' },
  { id: 'presets', label: 'PRESETS' },
  { id: 'system', label: 'SYSTEM' },
];

function SceneTab() {
  const sceneId = useVisual((s) => s.sceneId);
  const state = useVisual((s) => s.scenes[s.sceneId]) ?? defaultSceneState(sceneId);
  const setParam = useVisual((s) => s.setParam);
  const resetParam = useVisual((s) => s.resetParam);
  const resetScene = useVisual((s) => s.resetScene);
  const setBinding = useVisual((s) => s.setBinding);
  const addBinding = useVisual((s) => s.addBinding);
  const removeBinding = useVisual((s) => s.removeBinding);
  const def = getScene(sceneId);
  const schema = useMemo(() => getSceneSchema(def), [def]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ audio: true, camera: true });

  return (
    <div className="ins-scene">
      <div className="ins-scene-head">
        <span className="dim">SCENE {def.index}</span>
        <strong>{def.name}</strong>
        <p className="dim">{def.description}</p>
        <button type="button" className="btn btn-mini" onClick={resetScene}>
          RESET SCENE
        </button>
      </div>
      {PARAM_GROUPS.map((g) => {
        const defs = schema.filter((d) => d.group === g.id);
        if (defs.length === 0) return null;
        const isCollapsed = collapsed[g.id];
        const mods = state.modulations.filter((m) => defs.some((d) => d.key === m.target)).length;
        return (
          <section className="set-section" key={g.id}>
            <h3>
              <button type="button" className="group-toggle" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}>
                <span className="dim">{isCollapsed ? '+' : '−'}</span> {g.label}
                {mods > 0 && <span className="mod-count">~{mods}</span>}
              </button>
            </h3>
            {!isCollapsed &&
              defs.map((d) => {
                const binding = state.modulations.find((m) => m.target === d.key);
                return (
                  <ParamControl
                    key={d.key}
                    def={d}
                    value={state.params[d.key] ?? d.default}
                    onChange={(v) => setParam(d.key, v)}
                    onReset={() => resetParam(d.key)}
                    modTarget={d.type === 'number' && d.modulatable !== false ? d.key : undefined}
                    binding={binding}
                    onBind={() => addBinding(d.key)}
                    onBindingChange={setBinding}
                    onUnbind={() => binding && removeBinding(binding.id)}
                  />
                );
              })}
          </section>
        );
      })}
    </div>
  );
}

function FxTab() {
  const post = useVisual((s) => s.post);
  const sceneId = useVisual((s) => s.sceneId);
  const modulations = useVisual((s) => s.scenes[s.sceneId]?.modulations ?? []);
  const { addEffect, setEffectParam, toggleEffect, moveEffect, removeEffect, setBinding, addBinding, removeBinding } = useVisual.getState();
  const performance = useSettings((s) => s.performance);
  const degraded = useRuntime((s) => s.degraded);
  const budget = liveProfile(performance, degraded).maxEffects;
  const status = effectStatus(post, budget);
  const states = [...status.values()];
  const active = states.filter((x) => x === 'active').length;
  const overBudget = states.includes('budget');
  const bypassedTrails = states.filter((x) => x === 'trails-limit').length;
  void sceneId;

  return (
    <div className="ins-fx">
      <div className="fx-add">
        <label htmlFor="fx-add">ADD EFFECT</label>
        <select
          id="fx-add"
          value=""
          onChange={(e) => {
            if (e.target.value) addEffect(e.target.value as EffectType);
          }}
        >
          <option value="">+ SELECT…</option>
          {EFFECTS.map((e) => (
            <option key={e.type} value={e.type}>
              {e.name}
            </option>
          ))}
        </select>
      </div>
      <p className="set-note dim">
        STACK RUNS TOP → BOTTOM. {overBudget ? `QUALITY BUDGET: ONLY THE FIRST ${budget} ENABLED EFFECTS RENDER (${performance.toUpperCase()}).` : `${active} / ${budget} EFFECT SLOTS IN USE.`} EFFECTS ARE ALSO RENDERED INTO EXPORTED VIDEO.
        {bypassedTrails > 0 ? ` AT MOST ${MAX_TRAILS} MOTION TRAILS RENDER (EACH KEEPS ITS OWN FULL-SIZE HISTORY); ${bypassedTrails} BYPASSED.` : ''}
      </p>
      {post.length === 0 && <p className="dossier-empty dim">NO EFFECTS. ADD BLOOM, TRAILS, KALEIDOSCOPE…</p>}
      <ol className="fx-stack">
        {post.map((e, i) => {
          const def = EFFECT_MAP.get(e.type)!;
          const st = status.get(e.id);
          const skipped = st === 'budget' || st === 'trails-limit';
          return (
            <li key={e.id} className={`fx-item ${e.enabled ? '' : 'is-off'} ${skipped ? 'is-skipped' : ''}`}>
              <div className="fx-head">
                <span className="dim">{String(i + 1).padStart(2, '0')}</span>
                <strong title={def.description}>{def.name}</strong>
                <button type="button" className={`btn btn-mini ${e.enabled ? 'is-on' : ''}`} aria-pressed={e.enabled} onClick={() => toggleEffect(e.id)}>
                  {e.enabled ? 'ON' : 'OFF'}
                </button>
                <button type="button" className="icon-btn icon-mini" aria-label="Move up" disabled={i === 0} onClick={() => moveEffect(e.id, -1)}>
                  ↑
                </button>
                <button type="button" className="icon-btn icon-mini" aria-label="Move down" disabled={i === post.length - 1} onClick={() => moveEffect(e.id, 1)}>
                  ↓
                </button>
                <button type="button" className="icon-btn icon-mini" aria-label="Remove effect" onClick={() => removeEffect(e.id)}>
                  ✕
                </button>
              </div>
              {st === 'budget' && <p className="set-note">SKIPPED BY THE QUALITY BUDGET</p>}
              {st === 'trails-limit' && <p className="set-note">BYPASSED — AT MOST {MAX_TRAILS} MOTION TRAILS RENDER. REMOVE OR DISABLE ANOTHER ONE TO USE THIS.</p>}
              {e.enabled &&
                def.params.map((d) => {
                  const target = fxTarget(e.id, d.key);
                  const binding = modulations.find((m) => m.target === target);
                  return (
                    <ParamControl
                      key={d.key}
                      def={d}
                      value={e.params[d.key] ?? d.default}
                      onChange={(v) => setEffectParam(e.id, d.key, v)}
                      onReset={() => setEffectParam(e.id, d.key, d.default)}
                      modTarget={d.type === 'number' && d.modulatable !== false ? target : undefined}
                      binding={binding}
                      onBind={() => addBinding(target, 'kick')}
                      onBindingChange={setBinding}
                      onUnbind={() => binding && removeBinding(binding.id)}
                    />
                  );
                })}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Inspector() {
  const open = useUi((s) => s.inspectorOpen);
  const tab = useUi((s) => s.inspectorTab);
  const setTab = useUi((s) => s.setTab);
  const close = useUi((s) => s.closeInspector);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, [open]);

  return (
    <aside id="inspector" className={`settings inspector ${open ? 'is-open' : ''}`} aria-label="Inspector" aria-hidden={!open} inert={!open}>
      <header className="settings-head">
        <div className="ins-tabs" role="tablist" aria-label="Inspector sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <button ref={closeRef} type="button" className="icon-btn" onClick={close} aria-label="Close inspector">
          <CloseIcon />
        </button>
      </header>
      <div className="settings-body" role="tabpanel">
        {tab === 'scene' && <SceneTab />}
        {tab === 'fx' && <FxTab />}
        {tab === 'presets' && <PresetsTab />}
        {tab === 'system' && <SystemTab />}
      </div>
    </aside>
  );
}
