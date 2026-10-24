import { useEffect, useId, useRef, useState } from 'react';
import { MOD_CURVES, MOD_SOURCES, type ModulationBinding } from '../../engine/modulation';
import { formatParam } from '../../engine/params';
import type { ParamDef, ParamValue } from '../../engine/types';
import { getLiveEngine } from '../../visual/liveEngine';

function fillOf(def: ParamDef, v: number): number {
  const lo = def.min ?? 0;
  const hi = def.max ?? 1;
  return hi > lo ? (v - lo) / (hi - lo) : 0;
}

/** Thin marker on the slider showing the live, modulated value. */
function LiveMarker({ def, paramKey, bindingId }: { def: ParamDef; paramKey: string; bindingId: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const meter = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const engine = getLiveEngine();
      if (!engine) return;
      const v = paramKey.startsWith('fx:') ? undefined : engine.resolvedValue(paramKey);
      if (ref.current && v !== undefined) ref.current.style.left = `${(fillOf(def, v) * 100).toFixed(2)}%`;
      if (meter.current) meter.current.style.transform = `scaleX(${engine.modulation.level(bindingId).toFixed(3)})`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [def, paramKey, bindingId]);
  return (
    <>
      {!paramKey.startsWith('fx:') && <span className="mod-marker" ref={ref} />}
      <span className="mod-meter">
        <i ref={meter} />
      </span>
    </>
  );
}

function ModSlider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  const id = useId();
  return (
    <div className="mod-row">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ ['--fill' as string]: (value - min) / (max - min) }} />
      <output htmlFor={id}>{format ? format(value) : value.toFixed(2)}</output>
    </div>
  );
}

export function ModulationEditor({ binding, onChange, onRemove }: { binding: ModulationBinding; onChange: (b: ModulationBinding) => void; onRemove: () => void }) {
  const set = <K extends keyof ModulationBinding>(k: K, v: ModulationBinding[K]) => onChange({ ...binding, [k]: v });
  const ms = (v: number) => `${Math.round(v * 1000)} MS`;
  return (
    <div className="mod-editor">
      <div className="mod-row">
        <label>SOURCE</label>
        <select value={binding.source} onChange={(e) => set('source', e.target.value as ModulationBinding['source'])} aria-label="Modulation source">
          {MOD_SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-mini" onClick={onRemove}>
          REMOVE
        </button>
      </div>
      <ModSlider label="AMOUNT" value={binding.amount} min={-1} max={1} step={0.01} onChange={(v) => set('amount', v)} />
      {binding.source === 'lfo' && <ModSlider label="LFO RATE" value={binding.lfoRate} min={0.01} max={4} step={0.01} onChange={(v) => set('lfoRate', v)} format={(v) => `${v.toFixed(2)} HZ`} />}
      <ModSlider label="ATTACK" value={binding.attack} min={0.005} max={2} step={0.005} onChange={(v) => set('attack', v)} format={ms} />
      <ModSlider label="RELEASE" value={binding.release} min={0.005} max={4} step={0.005} onChange={(v) => set('release', v)} format={ms} />
      <ModSlider label="THRESHOLD" value={binding.threshold} min={0} max={0.95} step={0.01} onChange={(v) => set('threshold', v)} />
      <ModSlider label="MIN" value={binding.min} min={0} max={0.95} step={0.01} onChange={(v) => set('min', Math.min(v, binding.max - 0.05))} />
      <ModSlider label="MAX" value={binding.max} min={0.05} max={1} step={0.01} onChange={(v) => set('max', Math.max(v, binding.min + 0.05))} />
      <div className="mod-row">
        <label>CURVE</label>
        <div className="seg seg-compact" role="radiogroup" aria-label="Curve">
          {MOD_CURVES.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={binding.curve === c.id} className={binding.curve === c.id ? 'is-on' : ''} onClick={() => set('curve', c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mod-row">
        <label>INVERT</label>
        <button type="button" className={`btn btn-mini ${binding.invert ? 'is-on' : ''}`} aria-pressed={binding.invert} onClick={() => set('invert', !binding.invert)}>
          {binding.invert ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}

export interface ParamControlProps {
  def: ParamDef;
  value: ParamValue;
  onChange: (v: ParamValue) => void;
  onReset: () => void;
  /** modulation target key (absent → not modulatable here) */
  modTarget?: string;
  binding?: ModulationBinding;
  onBind?: () => void;
  onBindingChange?: (b: ModulationBinding) => void;
  onUnbind?: () => void;
}

export function ParamControl({ def, value, onChange, onReset, modTarget, binding, onBind, onBindingChange, onUnbind }: ParamControlProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const isDefault = value === def.default;

  if (def.type === 'number' && typeof value === 'number') {
    const canMod = !!modTarget && def.modulatable !== false;
    return (
      <div className={`prm ${binding ? 'is-mod' : ''}`}>
        <div className="prm-row">
          <label htmlFor={id} title={def.hint}>
            {def.label}
          </label>
          <span className="prm-slider">
            <input
              id={id}
              type="range"
              min={def.min}
              max={def.max}
              step={def.step ?? 0.01}
              value={value}
              onChange={(e) => onChange(Number(e.target.value))}
              onDoubleClick={onReset}
              style={{ ['--fill' as string]: fillOf(def, value) }}
            />
            {binding && modTarget && <LiveMarker def={def} paramKey={modTarget} bindingId={binding.id} />}
          </span>
          <output htmlFor={id} className={isDefault ? 'dim' : ''}>
            {formatParam(def, value)}
          </output>
          {canMod ? (
            <button
              type="button"
              className={`mod-btn ${binding ? 'is-on' : ''}`}
              aria-expanded={open}
              aria-label={`Modulation for ${def.label}`}
              title={binding ? `MODULATED BY ${binding.source.toUpperCase()}` : 'ADD AUDIO MODULATION'}
              onClick={() => {
                if (!binding) onBind?.();
                setOpen((o) => (binding ? !o : true));
              }}
            >
              ~
            </button>
          ) : (
            <span className="mod-btn-spacer" />
          )}
        </div>
        {open && binding && onBindingChange && onUnbind && (
          <ModulationEditor
            binding={binding}
            onChange={onBindingChange}
            onRemove={() => {
              onUnbind();
              setOpen(false);
            }}
          />
        )}
      </div>
    );
  }

  if (def.type === 'boolean') {
    return (
      <div className="prm prm-row">
        <label>{def.label}</label>
        <button type="button" className={`btn btn-mini ${value ? 'is-on' : ''}`} aria-pressed={value === true} onClick={() => onChange(!value)}>
          {value ? 'ON' : 'OFF'}
        </button>
      </div>
    );
  }

  if (def.type === 'select') {
    const opts = def.options ?? [];
    return (
      <div className="prm prm-row prm-select">
        <label htmlFor={id}>{def.label}</label>
        {opts.length <= 4 ? (
          <div className="seg seg-compact" role="radiogroup" aria-label={def.label}>
            {opts.map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  // colour
  return (
    <div className="prm prm-row prm-color">
      <label htmlFor={id}>{def.label}</label>
      <span className="color-pick">
        <input id={id} type="color" value={String(value)} onChange={(e) => onChange(e.target.value)} />
        <span>{String(value).toUpperCase()}</span>
      </span>
      {!isDefault && (
        <button type="button" className="btn btn-mini" onClick={onReset} title="Reset">
          ↺
        </button>
      )}
    </div>
  );
}
