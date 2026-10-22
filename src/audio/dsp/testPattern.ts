/**
 * Deterministic drum + bass test pattern with known hit positions. Used by the unit tests
 * to measure detection accuracy and by the UI ("TEST PATTERN") so the visualizer can be
 * tried without a file at hand. It deliberately contains a held bass passage and a block
 * of digital silence, both of which must not produce kick events.
 */

export interface TestPattern {
  samples: Float32Array;
  sampleRate: number;
  bpm: number;
  kicks: number[];
  snares: number[];
  hats: number[];
  /** [start, end] seconds of digital silence */
  silence: [number, number];
  /** [start, end] seconds where only a sustained bass (and pad) plays */
  heldBass: [number, number];
  duration: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthesizeTestPattern(sampleRate = 44100, bpm = 120): TestPattern {
  const beat = 60 / bpm;
  const bar = beat * 4;
  const bars = 14;
  const duration = bars * bar;
  const length = Math.round(duration * sampleRate);
  const out = new Float32Array(length);
  const rand = mulberry32(0xbea7f0);

  const kicks: number[] = [];
  const snares: number[] = [];
  const hats: number[] = [];

  const addKick = (t0: number) => {
    kicks.push(t0);
    const start = Math.round(t0 * sampleRate);
    const len = Math.round(0.42 * sampleRate);
    let phase = 0;
    for (let i = 0; i < len && start + i < length; i++) {
      const t = i / sampleRate;
      const f = 46 + 120 * Math.exp(-t / 0.04);
      phase += (2 * Math.PI * f) / sampleRate;
      const env = Math.min(1, t / 0.0015) * Math.exp(-t / 0.22);
      out[start + i] += 0.62 * env * Math.sin(phase);
    }
  };

  const addSnare = (t0: number) => {
    snares.push(t0);
    const start = Math.round(t0 * sampleRate);
    const len = Math.round(0.28 * sampleRate);
    let prev = 0;
    for (let i = 0; i < len && start + i < length; i++) {
      const t = i / sampleRate;
      const n = rand() * 2 - 1;
      const hp = n - prev; // first-order high-pass
      prev = n;
      const att = Math.min(1, t / 0.001);
      const tone = 0.22 * Math.sin(2 * Math.PI * 195 * t) * Math.exp(-t / 0.07);
      const noise = 0.2 * hp * Math.exp(-t / 0.1);
      out[start + i] += att * (tone + noise);
    }
  };

  const addHat = (t0: number, level = 1) => {
    hats.push(t0);
    const start = Math.round(t0 * sampleRate);
    const len = Math.round(0.07 * sampleRate);
    let p1 = 0;
    let p2 = 0;
    for (let i = 0; i < len && start + i < length; i++) {
      const t = i / sampleRate;
      const n = rand() * 2 - 1;
      const d1 = n - p1;
      const d2 = d1 - p2; // second-order difference: strong high-pass
      p1 = n;
      p2 = d1;
      out[start + i] += 0.075 * level * d2 * Math.min(1, t / 0.0007) * Math.exp(-t / 0.022);
    }
  };

  // Arrangement (bars of 4 beats):
  //  0-1   hats + pad                      (intro)
  //  2-5   four-on-the-floor, snare on 2/4, 8th hats, held bass
  //  6     held bass + pad only            (no drums: must not produce kicks)
  //  7     digital silence
  //  8-11  syncopated kick, snare on 2/4, 16th hats, held bass
  //  12-13 pad only                        (outro)
  for (let b = 0; b < bars; b++) {
    const t = b * bar;
    if (b <= 1) {
      for (let e = 0; e < 8; e++) addHat(t + e * (beat / 2), e % 2 ? 0.7 : 1);
    } else if (b >= 2 && b <= 5) {
      for (let q = 0; q < 4; q++) addKick(t + q * beat);
      addSnare(t + beat);
      addSnare(t + 3 * beat);
      for (let e = 0; e < 8; e++) if (e % 2 === 1) addHat(t + e * (beat / 2));
    } else if (b >= 8 && b <= 11) {
      addKick(t);
      addKick(t + 1.5 * beat);
      addKick(t + 2 * beat);
      addKick(t + 3 * beat);
      addSnare(t + beat);
      addSnare(t + 3 * beat);
      for (let s = 0; s < 16; s++) {
        if (s % 4 === 0) continue; // the beat itself is covered by kick/snare
        addHat(t + s * (beat / 4), s % 2 ? 0.65 : 1);
      }
    }
  }

  // Held bass: legato notes that change on bar lines with an equal-power crossfade, so the
  // low band stays loud without new transients.
  const bassStart = 2 * bar;
  const bassEnd = 7 * bar;
  const bass2Start = 8 * bar;
  const bass2End = 12 * bar;
  const notes = [55, 55, 49, 65.4, 55, 41.2, 55, 49, 65.4, 55];
  const fade = 0.12;
  const sectionGain = (t: number, s: number, e: number) => {
    if (t < s || t >= e) return 0;
    return Math.min(1, (t - s) / 0.35) * Math.min(1, (e - t) / 0.25);
  };
  let bassPhase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const g = Math.max(sectionGain(t, bassStart, bassEnd), sectionGain(t, bass2Start, bass2End));
    if (g <= 0) continue;
    const barIdx = Math.floor(t / bar);
    const inBar = t - barIdx * bar;
    const fA = notes[(barIdx + notes.length - 1) % notes.length];
    const fB = notes[barIdx % notes.length];
    const x = Math.min(1, inBar / fade);
    const f = fA + (fB - fA) * (0.5 - 0.5 * Math.cos(Math.PI * x));
    bassPhase += (2 * Math.PI * f) / sampleRate;
    out[i] += 0.2 * g * (Math.sin(bassPhase) + 0.18 * Math.sin(2 * bassPhase));
  }

  // Pad: soft chord with very slow attack in the mids, gives the mid band some body.
  const padFreqs = [220, 277.2, 329.6, 440];
  const silenceStart = 7 * bar;
  const silenceEnd = 8 * bar;
  const padGate = (t: number): number => {
    if (t < silenceStart - 0.3) return 1;
    if (t < silenceStart) return (silenceStart - t) / 0.3;
    if (t < silenceEnd) return 0;
    return Math.min(1, (t - silenceEnd) / 1.5);
  };
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const gate = padGate(t);
    if (gate <= 0) continue;
    const env = gate * Math.min(1, t / 1.5) * Math.min(1, Math.max(0, (duration - t) / 2));
    const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.25 * t);
    let s = 0;
    for (const f of padFreqs) s += Math.sin(2 * Math.PI * f * t + f);
    out[i] += 0.022 * env * lfo * s;
  }

  // Hard-zero the silence block (drum tails from the previous bar are cut as well).
  const s0 = Math.round(silenceStart * sampleRate);
  const s1 = Math.round(silenceEnd * sampleRate);
  for (let i = s0; i < s1 && i < length; i++) out[i] = 0;

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.95) {
    const g = 0.95 / peak;
    for (let i = 0; i < length; i++) out[i] *= g;
  }

  return {
    samples: out,
    sampleRate,
    bpm,
    kicks,
    snares,
    hats,
    silence: [silenceStart, silenceEnd],
    heldBass: [6 * bar, 7 * bar],
    duration,
  };
}
