import { PERFORMANCE_PRESETS } from '../../engine/quality';
import { useSettings, type ReducedMotionSetting } from '../../state/settings';
import { livePixelRatio, useRuntime } from '../../visual/runtime';
import { useSystemReducedMotion } from '../../visual/useReducedMotion';

function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="set-row set-row-seg">
      <span className="set-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.value)} type="button" role="radio" title={o.title} aria-checked={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SystemTab() {
  const performance = useSettings((s) => s.performance);
  const reducedMotion = useSettings((s) => s.reducedMotion);
  const fftSize = useSettings((s) => s.fftSize);
  const set = useSettings((s) => s.set);
  const systemReduced = useSystemReducedMotion();
  const fps = useRuntime((s) => s.fps);
  const dprScale = useRuntime((s) => s.dprScale);
  const degraded = useRuntime((s) => s.degraded);
  const renderer = useRuntime((s) => s.renderer);
  const hint = PERFORMANCE_PRESETS.find((p) => p.id === performance)?.hint;

  return (
    <div className="ins-system">
      <section className="set-section">
        <h3>
          <span className="dim">[01]</span> PERFORMANCE
        </h3>
        <Seg label="LIVE STAGE" value={performance} options={PERFORMANCE_PRESETS.map((p) => ({ value: p.id, label: p.label, title: p.hint }))} onChange={(v) => set('performance', v)} />
        <p className="set-note dim">
          {hint?.toUpperCase()}. NOW: {renderer === 'webgl' ? 'WEBGL2' : 'CANVAS 2D'} · {fps || '—'} FPS · DPR {livePixelRatio(performance, dprScale).toFixed(2)}
          {degraded ? ' · DETAIL AUTO-REDUCED' : ''}. VIDEO EXPORT HAS ITS OWN QUALITY SETTINGS.
        </p>
      </section>
      <section className="set-section">
        <h3>
          <span className="dim">[02]</span> MOTION &amp; ANALYSIS
        </h3>
        <Seg<ReducedMotionSetting>
          label={`REDUCED MOTION${reducedMotion === 'auto' ? ` (OS: ${systemReduced ? 'ON' : 'OFF'})` : ''}`}
          value={reducedMotion}
          options={[
            { value: 'auto', label: 'AUTO' },
            { value: 'on', label: 'ON' },
            { value: 'off', label: 'OFF' },
          ]}
          onChange={(v) => set('reducedMotion', v)}
        />
        <Seg<2048 | 4096>
          label="FFT SIZE"
          value={fftSize}
          options={[
            { value: 2048, label: '2048' },
            { value: 4096, label: '4096' },
          ]}
          onChange={(v) => set('fftSize', v)}
        />
      </section>
    </div>
  );
}
