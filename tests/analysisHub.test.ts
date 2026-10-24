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

describe('AnalysisHub — latency compensation at high refresh rates', () => {
  for (const fps of [60, 144, 240]) {
    it(`keeps analysing at ${fps} fps with the maximum compensation`, () => {
      // 350 + 70 ms output latency − 20 ms display allowance = 0.4 s, the maximum supported
      const f = fakeEngine({ out: 0.35, base: 0.07 });
      const hub = new AnalysisHub();
      hub.attach(f.engine);
      f.state.playing = true;
      let now = 1000;
      let maxBass = 0;
      let maxRms = 0;
      for (let t = 4; t < 6; t += 1 / fps) {
        f.state.time = t;
        f.analyser.seek(t);
        now += 1000 / fps;
        hub.tick(now);
        if (t > 4.6) {
          maxBass = Math.max(maxBass, hub.frame.bass);
          maxRms = Math.max(maxRms, hub.frame.rms);
        }
      }
      expect(hub.latency).toBeCloseTo(0.4, 5);
      expect(maxBass).toBeGreaterThan(0.2);
      expect(maxRms).toBeGreaterThan(0.05);
      expect(hub.frame.activity).toBeGreaterThan(0.5);
    });
  }
});

describe('AnalysisHub — delay line capacity', () => {
  it('holds the maximum compensation at the fastest accepted tick rate (250 Hz)', async () => {
    const { DELAY_SLOTS, MAX_COMPENSATION } = await import('../src/audio/analysis/AnalysisHub');
    expect(DELAY_SLOTS * 4).toBeGreaterThan(MAX_COMPENSATION * 1000);
    expect(DELAY_SLOTS).toBeLessThanOrEqual(256); // bounded memory
  });

  it('the visual delay equals the compensation at 240 fps (no stale or skipped results)', () => {
    const f = fakeEngine({ out: 0.35, base: 0.07 });
    const hub = new AnalysisHub();
    hub.attach(f.engine);
    f.state.playing = true;
    const fps = 240;
    let now = 1000;
    let onsetSeen = -1;
    // silence until the first kick at 4.0 s, then watch when the bass appears on screen
    for (let t = 3.2; t < 5; t += 1 / fps) {
      f.state.time = t;
      f.analyser.seek(t);
      now += 1000 / fps;
      hub.tick(now);
      if (onsetSeen < 0 && hub.frame.bass > 0.1) onsetSeen = t;
    }
    // shown ≈ 0.4 s after the analyser saw it (plus the analysis window)
    expect(onsetSeen - 4).toBeGreaterThan(0.38);
    expect(onsetSeen - 4).toBeLessThan(0.5);
  });
});

describe('AnalysisHub — an event at the very start of the track', () => {
  const zeroMap: EventMap = {
    times: new Float32Array([0, 0.5, 1.0]),
    strengths: new Float32Array([1, 1, 1]),
    types: new Uint8Array([EventType.KICK, EventType.KICK, EventType.KICK]),
  };
  function session(latency: number) {
    const f = fakeEngine({ out: latency, base: 0 });
    const hub = new AnalysisHub();
    hub.attach(f.engine);
    hub.setEventMap(zeroMap);
    let now = 1000;
    // while paused the position holds at `from`; while playing it advances to `to`
    const run = (from: number, to: number, playing: boolean) => {
      f.state.playing = playing;
      for (let t = from; t < to; t += 1 / 60) {
        f.state.time = playing ? t : from;
        f.analyser.seek(f.state.time);
        now += 1000 / 60;
        hub.tick(now);
      }
    };
    return { hub, run, kicks: () => hub.frame.counts[EventType.KICK] };
  }

  it('fires once when playback starts at 0 (after the output latency)', () => {
    const s = session(0.05);
    s.run(0, 0.1, false); // paused at the start
    s.run(0, 0.3, true);
    expect(s.kicks()).toBe(1);
    expect(s.hub.frame.lastTime[EventType.KICK]).toBe(0);
  });

  it('pause and resume do not repeat it', () => {
    const s = session(0.02);
    s.run(0, 0.2, true);
    s.run(0.2, 0.4, false);
    s.run(0.2, 0.45, true);
    expect(s.kicks()).toBe(1);
  });

  it('a loop restart (the element seeks to 0) fires it once more', () => {
    const s = session(0.02);
    s.run(0, 1.2, true);
    expect(s.kicks()).toBe(3);
    s.hub.onSeek(0);
    s.run(0, 0.2, true);
    expect(s.kicks()).toBe(4);
  });

  it('a seek past it never fires it', () => {
    const s = session(0.02);
    s.run(0, 0.05, false);
    s.hub.onSeek(0.2);
    s.run(0.2, 0.4, true);
    expect(s.kicks()).toBe(0);
  });
});
