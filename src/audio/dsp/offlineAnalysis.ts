/**
 * Offline (pre-)analysis of a decoded track. Pure and synchronous so it can run in a Web
 * Worker and in unit tests. Produces a light waveform, a per-bucket band-energy map, a
 * time-sorted map of probable kick / snare / hat / tonal attacks and an optional BPM
 * estimate. The event classification is heuristic: it works on a finished stereo mix and
 * cannot truly separate instruments.
 */
import { FFT, hannWindow, nextPowerOfTwo } from './fft';
import { AIR_BAND, BASS, BODY_BAND, HIGH, KICK_BAND, MID, SNAP_BAND, bandBins, powerToDb, type BandRange, type BinSpan } from './bands';
import { EventType, type EventMap } from './events';
import { percentile, pickPeaks } from './onset';

export interface OfflineAnalysisResult {
  duration: number;
  sampleRate: number;
  /** seconds between feature frames */
  hop: number;
  frameCount: number;
  buckets: number;
  /** interleaved [peak, rms] per bucket, linear amplitude 0..1 */
  waveform: Float32Array;
  /** interleaved [bass, mid, high] per bucket, normalized 0..1 */
  bandMap: Float32Array;
  events: EventMap;
  /** number of kick, snare, hat, tone events */
  counts: [number, number, number, number];
  bpm: number | null;
  bpmConfidence: number;
  peakDb: number;
  rmsDb: number;
}

export interface OfflineOptions {
  onProgress?: (fraction: number) => void;
}

/** Per-frame spectral features. Flux values are mean positive log-magnitude change per bin. */
export interface FrameFeatures {
  fps: number;
  hop: number;
  frameCount: number;
  flux: { kick: Float32Array; body: Float32Array; snap: Float32Array; air: Float32Array };
  /** fraction of kick-band bins whose log magnitude jumped noticeably (0..1) */
  kickSpread: Float32Array;
  db: {
    kick: Float32Array;
    body: Float32Array;
    snap: Float32Array;
    air: Float32Array;
    bass: Float32Array;
    mid: Float32Array;
    high: Float32Array;
  };
}

/** log-compression factor applied to the normalized magnitude spectrum */
const GAMMA = 100;
/** absolute ODF floor: tracks quieter than this are not normalized up into "onsets" */
const ODF_FLOOR = 0.15;
const LEVEL_GATE_DB = -62;
/** frame lag of the spectral difference (≈23 ms at the chosen hop) */
const LAG = 2;
/** log-magnitude jump that counts a bin as "rising" for the kick spread feature */
const SPREAD_STEP = 0.3;

export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  const g = 1 / channels.length;
  for (const ch of channels) {
    for (let i = 0; i < len; i++) out[i] += ch[i] * g;
  }
  return out;
}

export function computeFeatures(samples: Float32Array, sampleRate: number, progress: (f: number) => void = () => {}): FrameFeatures {
  const N = nextPowerOfTwo(Math.round(sampleRate * 0.046));
  const hopSamples = N / 4;
  const hop = hopSamples / sampleRate;
  const frameCount = Math.max(1, Math.ceil(samples.length / hopSamples));
  const binCount = N / 2;
  const fft = new FFT(N);
  const window = hannWindow(N);
  const norm = 4 / N; // a full-scale sine reads ~1.0 at its peak bin

  const span = (r: BandRange) => bandBins(r, sampleRate, N);
  const spans = {
    kick: span(KICK_BAND),
    body: span(BODY_BAND),
    snap: span(SNAP_BAND),
    air: span(AIR_BAND),
    bass: span(BASS),
    mid: span(MID),
    high: span(HIGH),
  };
  const f32 = () => new Float32Array(frameCount);
  const features: FrameFeatures = {
    fps: 1 / hop,
    hop,
    frameCount,
    flux: { kick: f32(), body: f32(), snap: f32(), air: f32() },
    kickSpread: f32(),
    db: { kick: f32(), body: f32(), snap: f32(), air: f32(), bass: f32(), mid: f32(), high: f32() },
  };
  const fluxBands = [
    [spans.kick, features.flux.kick],
    [spans.body, features.flux.body],
    [spans.snap, features.flux.snap],
    [spans.air, features.flux.air],
  ] as const;
  const dbBands = (Object.keys(features.db) as (keyof FrameFeatures['db'])[]).map((k) => [spans[k], features.db[k]] as const);

  const mag = new Float32Array(binCount + 1);
  const power = new Float32Array(binCount + 1);
  // Ring of log spectra for the lag-2, max-filtered (SuperFlux-like) difference. Starts as
  // zeros, i.e. "silence before the file", so a hit at t=0 is still an onset.
  const logRing: Float32Array[] = [];
  for (let i = 0; i <= LAG; i++) logRing.push(new Float32Array(binCount + 1));
  const maxFiltered = new Float32Array(binCount + 1);

  const meanPower = (s: BinSpan): number => {
    let acc = 0;
    for (let k = s.start; k < s.end; k++) acc += power[k];
    return acc / (s.end - s.start);
  };

  for (let f = 0; f < frameCount; f++) {
    fft.magnitudes(samples, f * hopSamples - N / 2, window, mag);
    const cur = logRing[f % (LAG + 1)];
    const prev = logRing[(f + 1) % (LAG + 1)]; // == frame f - LAG (zeros before the start)
    for (let k = 0; k <= binCount; k++) {
      const a = k > 0 ? prev[k - 1] : prev[k];
      const c = k < binCount ? prev[k + 1] : prev[k];
      maxFiltered[k] = Math.max(a, prev[k], c);
    }
    for (let k = 0; k <= binCount; k++) {
      const m = mag[k] * norm;
      power[k] = m * m;
      cur[k] = Math.log1p(GAMMA * m);
    }
    for (const [s, out] of fluxBands) {
      let acc = 0;
      for (let k = s.start; k < s.end; k++) {
        const d = cur[k] - maxFiltered[k];
        if (d > 0) acc += d;
      }
      out[f] = acc / (s.end - s.start);
    }
    let rising = 0;
    for (let k = spans.kick.start; k < spans.kick.end; k++) if (cur[k] - maxFiltered[k] > SPREAD_STEP) rising++;
    features.kickSpread[f] = rising / (spans.kick.end - spans.kick.start);
    for (const [s, out] of dbBands) out[f] = powerToDb(meanPower(s));
    if ((f & 511) === 0) progress(f / frameCount);
  }
  return features;
}

/** Frame-local maximum of `values` within ±radius frames. */
function localMax(values: Float32Array, i: number, radius: number): number {
  let m = -Infinity;
  for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) if (values[j] > m) m = values[j];
  return m;
}

/** Sliding maximum over a centered window, used for the relative (dynamic) threshold. */
function slidingMax(values: Float32Array, radius: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + radius);
    while (next <= hi) {
      while (tail > head && values[deque[tail - 1]] <= values[next]) tail--;
      deque[tail++] = next++;
    }
    while (deque[head] < i - radius) head++;
    out[i] = values[deque[head]];
  }
  return out;
}

export function detectEvents(ft: FrameFeatures): EventMap {
  const { fps, frameCount } = ft;
  const frames = (sec: number) => Math.max(1, Math.round(sec * fps));

  const normalize = (flux: Float32Array): Float32Array => {
    const scale = Math.max(percentile(flux, 0.98), ODF_FLOOR);
    const out = new Float32Array(flux.length);
    for (let i = 0; i < flux.length; i++) out[i] = flux[i] / scale;
    return out;
  };
  const kickN = normalize(ft.flux.kick);
  const snapN = normalize(ft.flux.snap);
  const airN = normalize(ft.flux.air);
  const bodyN = normalize(ft.flux.body);
  // Relative threshold: a peak must be a sizeable fraction of the strongest peak nearby, so
  // ripples in a kick's tail or bass beating do not count as new hits. The context is capped
  // so one outlier (e.g. the first hit after a silent break) cannot mask its neighbours.
  const context = (odf: Float32Array) => {
    const ctx = slidingMax(odf, frames(1.0));
    for (let i = 0; i < ctx.length; i++) if (ctx[i] > 1.2) ctx[i] = 1.2;
    return ctx;
  };
  const kickCtx = context(kickN);
  const snapCtx = context(snapN);
  const airCtx = context(airN);
  const bodyCtx = context(bodyN);

  const pick = (odf: Float32Array, wait: number) =>
    pickPeaks(odf, {
      preMax: frames(0.03),
      postMax: frames(0.03),
      preAvg: frames(0.12),
      postAvg: frames(0.07),
      delta: 0.12,
      minValue: 0.15,
      wait: frames(wait),
    });

  /** level rise around frame i: peak shortly after minus minimum shortly before */
  const rise = (db: Float32Array, i: number): { rise: number; peak: number } => {
    let lo = Infinity;
    for (let j = Math.max(0, i - frames(0.1)); j < i; j++) lo = Math.min(lo, db[j]);
    let hi = -Infinity;
    for (let j = i; j <= Math.min(db.length - 1, i + frames(0.035)); j++) hi = Math.max(hi, db[j]);
    if (lo === Infinity) lo = -200;
    return { rise: hi - lo, peak: hi };
  };
  const strengthOf = (v: number) => Math.min(1, 1 - Math.exp(-1.3 * v));
  const near = (sorted: number[], i: number, radius: number): boolean => {
    for (const j of sorted) {
      if (j > i + radius) break;
      if (Math.abs(j - i) <= radius) return true;
    }
    return false;
  };

  type Ev = { frame: number; type: number; strength: number };
  const events: Ev[] = [];

  // Kicks: low-band transient + real energy rise + relative threshold.
  const kicks: number[] = [];
  for (const i of pick(kickN, 0.1)) {
    // Beating between a kick tail and a held bass moves only a few low bins; a real kick
    // lights up most of the band. Weaker peaks therefore also need a wide in-band spread.
    const spread = localMax(ft.kickSpread, i, 1);
    if (kickN[i] < 0.45 * kickCtx[i]) continue;
    if (kickN[i] < 0.8 * kickCtx[i] && spread < 0.4) continue;
    const r = rise(ft.db.kick, i);
    if (r.peak < LEVEL_GATE_DB || r.rise < 5) continue;
    kicks.push(i);
    events.push({ frame: i, type: EventType.KICK, strength: strengthOf(kickN[i]) });
  }

  // Snares: a transient in the 2.5–6.5 kHz "snap" band that is broadband — the body band
  // (250–2500 Hz) moves with it, and the snap is strong relative to the air band (hats
  // put most of their change above 7 kHz).
  const snares: number[] = [];
  const R = 2;
  for (const i of pick(snapN, 0.09)) {
    if (snapN[i] < 0.3 * snapCtx[i]) continue;
    const r = rise(ft.db.snap, i);
    if (r.peak < LEVEL_GATE_DB || r.rise < 3) continue;
    const body = localMax(ft.flux.body, i, R);
    const snap = localMax(ft.flux.snap, i, R);
    const air = localMax(ft.flux.air, i, R);
    if (body >= 0.25 * snap && snap >= 0.55 * air) {
      snares.push(i);
      events.push({ frame: i, type: EventType.SNARE, strength: strengthOf(snapN[i]) });
    }
  }

  // Hats: air-band transients that are not part of a snare.
  for (const i of pick(airN, 0.05)) {
    if (airN[i] < 0.25 * airCtx[i]) continue;
    if (near(snares, i, R)) continue;
    const r = rise(ft.db.air, i);
    if (r.peak < LEVEL_GATE_DB - 8 || r.rise < 3) continue;
    events.push({ frame: i, type: EventType.HAT, strength: strengthOf(airN[i]) });
  }

  // Tonal attacks: body-band transients without a snare or kick at the same moment.
  for (const i of pick(bodyN, 0.09)) {
    if (bodyN[i] < 0.35 * bodyCtx[i]) continue;
    if (near(snares, i, R) || near(kicks, i, R)) continue;
    const r = rise(ft.db.body, i);
    if (r.peak < LEVEL_GATE_DB || r.rise < 4) continue;
    events.push({ frame: i, type: EventType.TONE, strength: strengthOf(bodyN[i]) * 0.8 });
  }

  events.sort((a, b) => a.frame - b.frame || a.type - b.type);
  const map: EventMap = {
    times: new Float32Array(events.length),
    strengths: new Float32Array(events.length),
    types: new Uint8Array(events.length),
  };
  events.forEach((e, idx) => {
    map.times[idx] = e.frame / fps;
    map.strengths[idx] = e.strength;
    map.types[idx] = e.type;
  });
  void frameCount;
  return map;
}

export function analyzeOffline(samples: Float32Array, sampleRate: number, options: OfflineOptions = {}): OfflineAnalysisResult {
  const progress = options.onProgress ?? (() => {});
  const length = samples.length;
  const duration = length / sampleRate;

  const ft = computeFeatures(samples, sampleRate, (f) => progress(f * 0.8));
  progress(0.8);
  const events = detectEvents(ft);
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < events.types.length; i++) counts[events.types[i]]++;
  progress(0.88);

  // ---- waveform + band map buckets ------------------------------------------------------
  const buckets = Math.min(4096, Math.max(512, Math.ceil(duration * 16)));
  const waveform = new Float32Array(buckets * 2);
  let peakAll = 0;
  let sumSq = 0;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor((b * length) / buckets);
    const e = Math.max(s + 1, Math.floor(((b + 1) * length) / buckets));
    let pk = 0;
    let sq = 0;
    for (let i = s; i < e && i < length; i++) {
      const v = samples[i];
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
      sq += v * v;
    }
    sumSq += sq;
    if (pk > peakAll) peakAll = pk;
    waveform[b * 2] = pk;
    waveform[b * 2 + 1] = Math.sqrt(sq / Math.max(1, e - s));
  }

  const bandMap = new Float32Array(buckets * 3);
  const RANGE = 45;
  [ft.db.bass, ft.db.mid, ft.db.high].forEach((db, bandIdx) => {
    const ref = Math.max(percentile(db, 0.99), -90);
    for (let b = 0; b < buckets; b++) {
      const fs = Math.floor((b * ft.frameCount) / buckets);
      const fe = Math.max(fs + 1, Math.floor(((b + 1) * ft.frameCount) / buckets));
      let s = 0;
      let c = 0;
      for (let f = fs; f < fe && f < ft.frameCount; f++) {
        s += db[f];
        c++;
      }
      const mean = c > 0 ? s / c : -200;
      const v = (mean - (ref - RANGE)) / RANGE;
      bandMap[b * 3 + bandIdx] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  });
  progress(0.95);

  const { bpm, confidence } = estimateTempo(ft, events.times.length);
  progress(1);

  return {
    duration,
    sampleRate,
    hop: ft.hop,
    frameCount: ft.frameCount,
    buckets,
    waveform,
    bandMap,
    events,
    counts,
    bpm,
    bpmConfidence: confidence,
    peakDb: peakAll > 0 ? 20 * Math.log10(peakAll) : -Infinity,
    rmsDb: length > 0 && sumSq > 0 ? 10 * Math.log10(sumSq / length) : -Infinity,
  };
}

/**
 * Autocorrelation tempo estimate over a combined onset function, weighted by a broad prior
 * around 120 BPM. Informational only: visuals never use it to fake beats.
 */
export function estimateTempo(ft: FrameFeatures, eventCount: number): { bpm: number | null; confidence: number } {
  const { fps } = ft;
  const total = ft.frameCount;
  if (eventCount < 8 || total / fps < 6) return { bpm: null, confidence: 0 };
  const scale = (a: Float32Array) => 1 / Math.max(percentile(a, 0.98), ODF_FLOOR);
  const sk = scale(ft.flux.kick);
  const ss = scale(ft.flux.snap);
  const sa = scale(ft.flux.air);
  const maxFrames = Math.round(fps * 120);
  const start = total > maxFrames ? Math.floor((total - maxFrames) / 2) : 0;
  const n = Math.min(total, maxFrames);
  const odf = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const j = start + i;
    const v = Math.min(3, ft.flux.kick[j] * sk) + 0.5 * Math.min(3, ft.flux.snap[j] * ss) + 0.25 * Math.min(3, ft.flux.air[j] * sa);
    odf[i] = v;
    mean += v;
  }
  mean /= n;
  for (let i = 0; i < n; i++) odf[i] -= mean;

  const minLag = Math.floor((60 / 200) * fps);
  const maxLag = Math.min(n - 2, Math.ceil((60 / 60) * fps));
  if (maxLag <= minLag + 2) return { bpm: null, confidence: 0 };
  const ac = new Float32Array(maxLag + 2);
  let zero = 0;
  for (let i = 0; i < n; i++) zero += odf[i] * odf[i];
  if (zero <= 1e-9) return { bpm: null, confidence: 0 };
  zero /= n;
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += odf[i] * odf[i + lag];
    ac[lag] = s / (n - lag);
  }
  let best = -1;
  let bestScore = -Infinity;
  let acMean = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const octaves = Math.log2((60 * fps) / lag / 120);
    const score = ac[lag] * Math.exp(-0.5 * (octaves / 0.9) ** 2);
    acMean += ac[lag];
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  acMean /= maxLag - minLag + 1;
  if (best < 0) return { bpm: null, confidence: 0 };
  const y0 = ac[best - 1];
  const y1 = ac[best];
  const y2 = ac[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = Math.abs(denom) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const confidence = Math.max(0, Math.min(1, (y1 - acMean) / Math.max(1e-9, zero - acMean)));
  const bpm = Math.round(((60 * fps) / (best + shift)) * 2) / 2;
  return { bpm: confidence >= 0.12 ? bpm : null, confidence };
}
