/**
 * Technical captions around the stage. Live values are written straight into the DOM from a
 * requestAnimationFrame loop (no React state per frame); slow-changing labels are React.
 */
import { useEffect, useRef } from 'react';
import { analysisHub } from '../audio/analysis/AnalysisHub';
import { usePlayer } from '../state/player';
import { useSettings } from '../state/settings';
import { getScene } from '../engine/scenes/registry';
import { eventsLabel, fftLabel, figLabel, HUD_LIGHTS as LIGHTS, HUD_METERS as METERS, lightOn, meterFill, meterText, readoutLabel, type EventsState } from '../overlay/model';
import { useVisual } from '../state/visual';
import { useRuntime } from '../visual/runtime';
import { telemetry } from '../visual/telemetry';

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
  const sceneId = useVisual((s) => s.sceneId);
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
  const m = getScene(sceneId);

  const readout = useRef<HTMLSpanElement>(null);
  const avRef = useRef<HTMLSpanElement>(null);
  const meterFillEls = useRef<(HTMLSpanElement | null)[]>([]);
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
        const el = meterFillEls.current[i];
        if (el) el.style.transform = `scaleX(${meterFill(levels[i]).toFixed(3)})`;
      }
      const env = [f.kick, f.snare, f.hat, f.tone];
      for (let i = 0; i < 4; i++) {
        const el = lights.current[i];
        if (el) el.style.setProperty('--on', lightOn(env[i]).toFixed(3));
      }
      if (n++ % 6 === 0) {
        for (let i = 0; i < 3; i++) {
          const el = meterVal.current[i];
          if (el) el.textContent = meterText(levels[i]);
        }
        if (readout.current) readout.current.textContent = readoutLabel(telemetry.rotation, telemetry.tilt, useRuntime.getState().fps);
        if (avRef.current) avRef.current.textContent = `AV SYNC +${Math.round(analysisHub.latency * 1000)} MS`;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  const rate = sampleRate || 0;
  let events: EventsState = { kind: 'none' };
  if (status === 'ready') {
    if (analysisStatus === 'ready' && analysis) events = { kind: 'mapped', events: analysis.events.times.length, bpm: analysis.bpm };
    else if (analysisStatus === 'unavailable') events = { kind: 'realtime', note: analysisMessage };
    else events = { kind: 'pending' };
  }

  return (
    <div className="hud" aria-hidden="false">
      <div className="hud-tl">
        <span className="hud-strong">{figLabel(m.index, m.name)}</span>
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
                <span className="meter-fill" ref={(el) => void (meterFillEls.current[i] = el)} />
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
        <span>{fftLabel(fftSize, rate)}</span>
        <span className="hud-dim">{eventsLabel(events)}</span>
        <span className="hud-dim hud-av" ref={avRef} title="Visuals are delayed by the measured audio output latency">
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
