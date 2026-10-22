import { describe, expect, it } from 'vitest';
import { AnalysisHub } from '../src/audio/analysis/AnalysisHub';
import { EventType, type EventMap } from '../src/audio/dsp/events';
import type { AudioEngine } from '../src/audio/engine/AudioEngine';
import { synthesizeTestPattern } from '../src/audio/dsp/testPattern';
import { FakeAnalyser } from './fakeAnalyser';

const SR = 48000;
const pattern = synthesizeTestPattern(SR, 120);

/** Minimal stand-in for AudioEngine: a media clock driven by the test. */
function fakeEngine(latency: { out: number; base: number }) {
  const analyser = new FakeAnalyser(pattern.samples, SR);
  const state = { time: 0, playing: false, seeking: false };
  const engine = {
    analyser,
    ctx: { sampleRate: SR, outputLatency: latency.out, baseLatency: latency.base },
    audio: { get seeking() {
      return state.seeking;
    } },
    get hasSource() {
      return true;
    },
    get isPlaying() {
      return state.playing;
    },
    readClock: () => state.time,
  };
  return { engine: engine as unknown as AudioEngine, analyser, state };
}

const kickMap: EventMap = {
  times: new Float32Array(pattern.kicks),
  strengths: new Float32Array(pattern.kicks.length).fill(1),
  types: new Uint8Array(pattern.kicks.length).fill(EventType.KICK),
};

function runHub(hub: AnalysisHub, f: ReturnType<typeof fakeEngine>, from: number, to: number, onTick?: (t: number) => void) {
  let now = 1000 + from * 1000;
  for (let t = from; t < to; t += 1 / 60) {
    f.state.time = t;
    f.analyser.seek(t);
    now += 1000 / 60;
    hub.tick(now);
    onTick?.(t);
  }
}

describe('AnalysisHub', () => {
  it('fires mapped events at the audible time (latency compensated)', () => {
    const f = fakeEngine({ out: 0.06, base: 0.01 });
    const hub = new AnalysisHub();
    hub.attach(f.engine);
    hub.setEventMap(kickMap);
    f.state.playing = true;
    const fired: { media: number; ev: number }[] = [];
    let seen = 0;
    runHub(hub, f, 3.9, 6.1, (t) => {
      if (hub.frame.counts[EventType.KICK] !== seen) {
        seen = hub.frame.counts[EventType.KICK];
        fired.push({ media: t, ev: hub.frame.lastTime[EventType.KICK] });
      }
    });
    expect(hub.latency).toBeCloseTo(0.05, 3); // 60 + 10 − 20 ms display allowance
    expect(fired.map((x) => x.ev)).toEqual([4, 4.5, 5, 5.5, 6]);
    for (const x of fired) {
      const delay = x.media - x.ev;
      expect(delay).toBeGreaterThanOrEqual(0.05 - 1e-6);
      expect(delay).toBeLessThan(0.05 + 1 / 60 + 1e-6);
    }
  });

  it('never fires events while paused, and impulses decay to zero', () => {
    const f = fakeEngine({ out: 0, base: 0 });
    const hub = new AnalysisHub();
    hub.attach(f.engine);
    hub.setEventMap(kickMap);
    f.state.playing = true;
    runHub(hub, f, 3.95, 4.1);
    expect(hub.frame.kick).toBeGreaterThan(0.5);
    const before = Array.from(hub.frame.counts);
    f.state.playing = false;
    // the clock does not move while paused, but keep ticking for a while
    let now = 50_000;
    for (let i = 0; i < 120; i++) {
      now += 1000 / 60;
      hub.tick(now);
    }
    expect(Array.from(hub.frame.counts)).toEqual(before);
    expect(hub.frame.kick).toBe(0);
    expect(hub.frame.activity).toBeLessThan(0.1);
  });

  it('does not fire events from a skipped region after a seek', () => {
    const f = fakeEngine({ out: 0.03, base: 0.01 });
    const hub = new AnalysisHub();
    hub.attach(f.engine);
    hub.setEventMap(kickMap);
    f.state.playing = true;
    runHub(hub, f, 3.9, 4.2);
    const fired: number[] = [];
    let seen = hub.frame.counts[EventType.KICK];
    hub.onSeek(8.2);
    runHub(hub, f, 8.2, 9.1, () => {
      if (hub.frame.counts[EventType.KICK] !== seen) {
        seen = hub.frame.counts[EventType.KICK];
        fired.push(hub.frame.lastTime[EventType.KICK]);
      }
    });
    expect(fired).toEqual([8.5, 9]);
  });

  it('uses real-time detection when no map is available', () => {
    const f = fakeEngine({ out: 0, base: 0 });
    const hub = new AnalysisHub();
    hub.attach(f.engine);
    f.state.playing = true;
    runHub(hub, f, 3.5, 8.1);
    expect(hub.frame.eventSource).toBe('realtime');
    // 4.0 … 8.0 contains 9 kicks; allow one miss at the start (warm-up)
    expect(hub.frame.counts[EventType.KICK]).toBeGreaterThanOrEqual(8);
    expect(hub.frame.counts[EventType.KICK]).toBeLessThanOrEqual(9);
  });

  it('rests at zero during digital silence', () => {
    const f = fakeEngine({ out: 0, base: 0 });
    const hub = new AnalysisHub();
    hub.attach(f.engine);
    f.state.playing = true;
    const [s, e] = pattern.silence;
    const countsBefore = { n: 0 };
    runHub(hub, f, s - 0.5, s + 0.01);
    countsBefore.n = hub.frame.counts.reduce((a, b) => a + b, 0);
    runHub(hub, f, s + 0.01, e - 0.05);
    expect(hub.frame.counts.reduce((a, b) => a + b, 0)).toBe(countsBefore.n);
    expect(hub.frame.bass).toBeLessThan(0.02);
    expect(hub.frame.kick + hub.frame.snare + hub.frame.hat).toBe(0);
    expect(Math.max(...hub.frame.spectrum)).toBeLessThan(0.02);
  });
});
