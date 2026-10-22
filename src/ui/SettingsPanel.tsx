import { useEffect, useId, useRef, type ReactNode } from 'react';
import {
  ACCENT_PRESETS,
  BACKGROUND_PRESETS,
  DEFAULT_SETTINGS,
  MODES,
  RANGES,
  useSettings,
  type NumericSettingKey,
  type QualitySetting,
  type ReducedMotionSetting,
} from '../state/settings';
import { useRuntime } from '../visual/runtime';
import { useSystemReducedMotion } from '../visual/useReducedMotion';
import { ExportSection } from './ExportPanel';
import { CloseIcon } from './icons';

function Section({ index, title, children }: { index: string; title: string; children: ReactNode }) {
  return (
    <section className="set-section">
      <h3>
        <span className="dim">[{index}]</span> {title}
      </h3>
      {children}
    </section>
  );
}

function Slider({ k, label, format }: { k: NumericSettingKey; label: string; format?: (v: number) => string }) {
  const value = useSettings((s) => s[k]);
  const set = useSettings((s) => s.set);
  const id = useId();
  const r = RANGES[k];
  const fill = (value - r.min) / (r.max - r.min);
  const isDefault = Math.abs(value - DEFAULT_SETTINGS[k]) < 1e-6;
  return (
    <div className="set-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={r.min}
        max={r.max}
        step={r.step}
        value={value}
        onChange={(e) => set(k, Number(e.target.value))}
        onDoubleClick={() => set(k, DEFAULT_SETTINGS[k])}
        style={{ ['--fill' as string]: fill }}
      />
      <output htmlFor={id} className={isDefault ? 'dim' : ''}>
        {format ? format(value) : value.toFixed(2)}
      </output>
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="set-row set-row-seg">
      <span className="set-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ColorRow({ label, k, presets }: { label: string; k: 'accent' | 'background'; presets: string[] }) {
  const value = useSettings((s) => s[k]);
  const set = useSettings((s) => s.set);
  const id = useId();
  return (
    <div className="set-row set-row-color">
      <span className="set-label">{label}</span>
      <div className="swatches">
        {presets.map((c) => (
          <button
            key={c}
            type="button"
            className={`swatch ${value === c ? 'is-on' : ''}`}
            style={{ background: c }}
            onClick={() => set(k, c)}
            aria-label={`${label} ${c}`}
            aria-pressed={value === c}
          />
        ))}
        <label className="swatch swatch-custom" htmlFor={id} title="Custom colour">
          <input id={id} type="color" value={value} onChange={(e) => set(k, e.target.value)} aria-label={`Custom ${label.toLowerCase()}`} />
          <span>{value.toUpperCase()}</span>
        </label>
      </div>
    </div>
  );
}

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mode = useSettings((s) => s.mode);
  const reducedMotion = useSettings((s) => s.reducedMotion);
  const fftSize = useSettings((s) => s.fftSize);
  const quality = useSettings((s) => s.quality);
  const set = useSettings((s) => s.set);
  const reset = useSettings((s) => s.reset);
  const systemReduced = useSystemReducedMotion();
  const autoDetail = useRuntime((s) => s.autoDetail);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const mult = (v: number) => `×${v.toFixed(2)}`;

  return (
    <aside
      ref={panelRef}
      id="settings-panel"
      className={`settings ${open ? 'is-open' : ''}`}
      aria-label="Visualizer settings"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="settings-head">
        <span>
          SETTINGS <span className="dim">/ LIVE</span>
        </span>
        <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
          <CloseIcon />
        </button>
      </header>
      <div className="settings-body">
        <Section index="01" title="MODE">
          <div className="seg seg-wide" role="radiogroup" aria-label="Visual mode">
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'is-on' : ''} onClick={() => set('mode', m.id)}>
                <span className="dim">{m.index}</span> {m.short}
              </button>
            ))}
          </div>
        </Section>
        <Section index="02" title="COLOUR">
          <ColorRow label="MAIN" k="accent" presets={ACCENT_PRESETS} />
          <ColorRow label="BACKGROUND" k="background" presets={BACKGROUND_PRESETS} />
        </Section>
        <Section index="03" title="SENSITIVITY">
          <Slider k="bassSensitivity" label="BASS" format={mult} />
          <Slider k="midSensitivity" label="MID" format={mult} />
          <Slider k="highSensitivity" label="HIGH" format={mult} />
        </Section>
        <Section index="04" title="RESPONSE">
          <Slider k="beatImpact" label="BEAT IMPACT" format={mult} />
          <Slider k="smoothing" label="SMOOTHING" format={pct} />
        </Section>
        <Section index="05" title="FORM">
          <Slider k="intensity" label="INTENSITY" format={mult} />
          <Slider k="particleDensity" label="PARTICLES" format={pct} />
          <Slider k="rotationSpeed" label="ROTATION" format={mult} />
        </Section>
        <Section index="06" title="SYSTEM">
          <Segmented<ReducedMotionSetting>
            label={`REDUCED MOTION${reducedMotion === 'auto' ? ` (OS: ${systemReduced ? 'ON' : 'OFF'})` : ''}`}
            value={reducedMotion}
            options={[
              { value: 'auto', label: 'AUTO' },
              { value: 'on', label: 'ON' },
              { value: 'off', label: 'OFF' },
            ]}
            onChange={(v) => set('reducedMotion', v)}
          />
          <Segmented<2048 | 4096>
            label="FFT SIZE"
            value={fftSize}
            options={[
              { value: 2048, label: '2048' },
              { value: 4096, label: '4096' },
            ]}
            onChange={(v) => set('fftSize', v)}
          />
          <Segmented<QualitySetting>
            label={`DETAIL${quality === 'auto' ? ` (${autoDetail.toUpperCase()})` : ''}`}
            value={quality}
            options={[
              { value: 'auto', label: 'AUTO' },
              { value: 'high', label: 'HIGH' },
              { value: 'low', label: 'LOW' },
            ]}
            onChange={(v) => set('quality', v)}
          />
        </Section>
        <Section index="07" title="EXPORT VIDEO">
          <ExportSection />
        </Section>
        <div className="settings-foot">
          <button type="button" className="btn" onClick={reset}>
            RESET TO DEFAULTS
          </button>
          <p className="dim">SAVED IN THIS BROWSER ONLY. DOUBLE-CLICK A SLIDER TO RESET IT.</p>
        </div>
      </div>
    </aside>
  );
}
