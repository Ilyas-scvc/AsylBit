/**
 * Technical captions around the stage. Live values are written straight into the DOM from a
 * requestAnimationFrame loop (no React state per frame); slow-changing labels are React.
 */
import { useEffect, useRef } from 'react';
import { analysisHub } from '../audio/analysis/AnalysisHub';
import { binWidth } from '../audio/dsp/bands';
import { usePlayer } from '../state/player';
import { MODES, useSettings } from '../state/settings';
import { useRuntime } from '../visual/runtime';
import { telemetry } from '../visual/telemetry';
import { formatKhz } from './format';

const LIGHTS = [
  { key: 'kick', label: 'KICK' },
  { key: 'snare', label: 'SNARE' },
  { key: 'hat', label: 'HAT' },
  { key: 'tone', label: 'TONE' },
] as const;

const METERS = [
  { key: 'bass', label: 'BASS', range: '20–150 HZ' },
  { key: 'mid', label: 'MID', range: '150–2K' },
  { key: 'high', label: 'HIGH', range: '2K–12K' },
] as const;

export function useStateLabel(): { text: string; tone: 'idle' | 'live' | 'busy' | 'error' } {
  const status = usePlayer((s) => s.status);
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const analysisStatus = usePlayer((s) => s.analysisStatus);
  const progress = usePlayer((s) => s.analysisProgress);
  if (status === 'empty') return { text: 'IDLE — NO SIGNAL', tone: 'idle' };
  if (status === 'error') return { text: 'ERROR', tone: 'error' };
  if (status === 'loading') return { text: 'LOADING', tone: 'busy' };
  if (buffering && playing) return { text: 'BUFFERING', tone: 'busy' };
  const base = playing ? 'PLAYING' : 'PAUSED';
  if (analysisStatus === 'decoding') return { text: `${base} · DECODING`, tone: playing ? 'live' : 'busy' };
  if (analysisStatus === 'analyzing') return { text: `${base} · ANALYZING ${Math.round(progress * 100)}%`, tone: playing ? 'live' : 'busy' };
  return { text: playing ? 'PLAYING' : 'READY · PAUSED', tone: playing ? 'live' : 'idle' };
}

export function Hud() {
  const mode = useSettings((s) => s.mode);
  const fftSize = useSettings((s) => s.fftSize);
  const sampleRate = usePlayer((s) => s.sampleRate);
  const analysisStatus = usePlayer((s) => s.analysisStatus);
  const analysis = usePlayer((s) => s.analysis);
  const analysisMessage = usePlayer((s) => s.analysisMessage);
  const status = usePlayer((s) => s.status);
  const renderer = useRuntime((s) => s.renderer);
  const fallbackReason = useRuntime((s) => s.fallbackReason);
  const contextLost = useRuntime((s) => s.contextLost);
  const visible = useRuntime((s) => s.stageVisible);
  const state = useStateLabel();
  const m = MODES.find((x) => x.id === mode)!;

  const readout = useRef<HTMLSpanElement>(null);
  const avRef = useRef<HTMLSpanElement>(null);
  const meterFill = useRef<(HTMLSpanElement | null)[]>([]);
  const meterVal = useRef<(HTMLSpanElement | null)[]>([]);
  const lights = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    let n = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      analysisHub.tick(now);
      const f = analysisHub.frame;
      const levels = [f.bass, f.mid, f.high];
      for (let i = 0; i < 3; i++) {
        const el = meterFill.current[i];
        if (el) el.style.transform = `scaleX(${Math.min(1, levels[i]).toFixed(3)})`;
      }
      const env = [f.kick, f.snare, f.hat, f.tone];
      for (let i = 0; i < 4; i++) {
        const el = lights.current[i];
        if (el) el.style.setProperty('--on', Math.min(1, env[i] * 1.6).toFixed(3));
      }
      if (n++ % 6 === 0) {
        for (let i = 0; i < 3; i++) {
          const el = meterVal.current[i];
          if (el) el.textContent = Math.min(9.99, levels[i]).toFixed(2);
        }
        if (readout.current) {
          const fps = useRuntime.getState().fps;
          readout.current.textContent = `[ROT ${telemetry.rotation.toFixed(1).padStart(5, '0')}°] [TILT ${telemetry.tilt.toFixed(1)}°] [FPS ${fps || '—'}]`;
        }
        if (avRef.current) avRef.current.textContent = `AV SYNC +${Math.round(analysisHub.latency * 1000)} MS`;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  const rate = sampleRate || 0;
  const binHz = rate ? binWidth(rate, fftSize).toFixed(1) : '—';
  let eventsLabel = 'EVENTS: —';
  if (status === 'ready') {
    if (analysisStatus === 'ready' && analysis) {
      const total = analysis.events.times.length;
      eventsLabel = `EVENTS: MAPPED · ${total}${analysis.bpm ? ` · ≈${analysis.bpm} BPM` : ''}`;
    } else if (analysisStatus === 'unavailable') {
      eventsLabel = `EVENTS: REAL-TIME · ${analysisMessage ?? ''}`;
    } else {
      eventsLabel = 'EVENTS: REAL-TIME (MAP PENDING)';
    }
  }

  return (
    <div className="hud" aria-hidden="false">
      <div className="hud-tl">
        <span className="hud-strong">
          FIG. {m.index} — {m.name}
        </span>
        <span className="hud-dim" ref={readout}>
          [ROT 000.0°] [TILT 0.0°] [FPS —]
        </span>
        {renderer === 'canvas2d' && <span className="hud-warn">CANVAS 2D FALLBACK · {fallbackReason}</span>}
        {contextLost && <span className="hud-warn">GPU CONTEXT LOST — RESTORING…</span>}
        <div className="hud-meters" role="group" aria-label="Live audio meters">
          {METERS.map((mt, i) => (
            <div className="meter" key={mt.key}>
              <span className="meter-label">{mt.label}</span>
              <span className="meter-track">
                <span className="meter-fill" ref={(el) => void (meterFill.current[i] = el)} />
              </span>
              <span className="meter-val" ref={(el) => void (meterVal.current[i] = el)}>
                0.00
              </span>
              <span className="meter-range">{mt.range}</span>
            </div>
          ))}
          <div className="lights">
            {LIGHTS.map((l, i) => (
              <span className="light" key={l.key} ref={(el) => void (lights.current[i] = el)}>
                <i />
                {l.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="hud-tr">
        <span>
          FFT {fftSize} · {formatKhz(rate)} · {binHz} HZ/BIN
        </span>
        <span className="hud-dim">{eventsLabel}</span>
        <span className="hud-dim" ref={avRef} title="Visuals are delayed by the measured audio output latency">
          AV SYNC +0 MS
        </span>
      </div>
      <div className={`hud-state tone-${state.tone}`}>
        <i />
        {state.text}
      </div>
    </div>
  );
}
