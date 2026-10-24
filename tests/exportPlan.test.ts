import { describe, expect, it } from 'vitest';
import { AnalysisHub } from '../src/audio/analysis/AnalysisHub';
import { analyzeOffline } from '../src/audio/dsp/offlineAnalysis';
import { synthesizeTestPattern } from '../src/audio/dsp/testPattern';
import { PcmAnalyser, PcmRing, virtualEngine } from '../src/export/PcmAnalyser';
import {
  analysisTime,
  audioBitrates,
  audioCodecFor,
  audioSampleRange,
  clampRange,
  codecsFor,
  CONTAINERS,
  DEFAULT_FPS,
  estimateBytes,
  exportFileName,
  FPS_OPTIONS,
  frameCount,
  frameTime,
  frameTimestamp,
  preRollStart,
  QUALITY_LEVELS,
  RESOLUTIONS,
  videoBitrate,
} from '../src/export/plan';
import { FakeAnalyser } from './fakeAnalyser';

describe('formats', () => {
  it('only pairs codecs with containers that can hold them', () => {
    expect(codecsFor('mp4')).toEqual(['avc', 'hevc']);
    expect(codecsFor('mov')).toEqual(['avc', 'hevc']);
    expect(codecsFor('webm')).toEqual(['vp9', 'vp8']);
    expect(audioCodecFor('mp4')).toBe('aac');
    expect(audioCodecFor('mov')).toBe('aac');
    expect(audioCodecFor('webm')).toBe('opus');
  });

  it('names files with the extension of the real container (never WebM as .mp4)', () => {
    for (const c of CONTAINERS) {
      const name = exportFileName('My Track (final).flac', c.id, 1080, 1920, 30);
      expect(name.endsWith(`.${c.extension}`)).toBe(true);
      expect(name).toMatch(/^[\w.-]+$/);
      expect(name).toContain('1080x1920');
    }
    expect(CONTAINERS.find((c) => c.id === 'webm')!.mime).toBe('video/webm');
    expect(CONTAINERS.find((c) => c.id === 'mov')!.mime).toBe('video/quicktime');
  });

  it('offers 24/25/30/60 fps with 30 as the default', () => {
    expect(FPS_OPTIONS).toEqual([24, 25, 30, 60]);
    expect(DEFAULT_FPS).toBe(30);
  });

  it('lists the required sizes per aspect with even dimensions; 4K sizes need an encoder check', () => {
    const sizes = (a: keyof typeof RESOLUTIONS) => RESOLUTIONS[a].map((r) => `${r.width}x${r.height}`);
    expect(sizes('16:9')).toEqual(['1280x720', '1920x1080', '3840x2160']);
    expect(sizes('9:16')).toEqual(['720x1280', '1080x1920', '2160x3840']);
    expect(sizes('1:1')).toEqual(['1080x1080']);
    for (const list of Object.values(RESOLUTIONS)) {
      for (const r of list) {
        expect(r.width % 2).toBe(0);
        expect(r.height % 2).toBe(0);
        expect(!!r.requiresCheck).toBe(r.width * r.height > 1920 * 1088);
      }
    }
  });

  it('maps quality levels to sensible bitrates', () => {
    const at = (q: (typeof QUALITY_LEVELS)[number]['id']) => videoBitrate('avc', 1920, 1080, 30, q);
    expect(at('low')).toBeLessThan(at('standard'));
    expect(at('standard')).toBeLessThan(at('high'));
    expect(at('high')).toBeLessThan(at('veryhigh'));
    expect(at('standard')).toBeGreaterThan(3e6);
    expect(at('standard')).toBeLessThan(10e6);
    expect(videoBitrate('hevc', 1920, 1080, 30, 'standard')).toBeLessThan(at('standard'));
    expect(videoBitrate('avc', 1920, 1080, 60, 'standard')).toBeGreaterThan(at('standard'));
    expect(videoBitrate('avc', 1920, 1080, 60, 'standard')).toBeLessThan(2 * at('standard'));
    expect(videoBitrate('avc', 3840, 2160, 60, 'veryhigh')).toBeLessThanOrEqual(80e6);
    expect(audioBitrates('aac', 'high')[0]).toBe(256000);
    expect(audioBitrates('aac', 'standard')[0]).toBe(192000);
    expect(audioBitrates('opus', 'standard').every((b) => b <= 192000)).toBe(true);
  });

  it('estimates size from the bitrates', () => {
    expect(estimateBytes(8e6, 192e3, 60)).toBeGreaterThan(((8e6 + 192e3) / 8) * 60 * 0.95);
    expect(estimateBytes(8e6, 192e3, 60)).toBeLessThan(((8e6 + 192e3) / 8) * 60 * 1.2);
  });
});

describe('frame timing', () => {
  it('uses t = start + n / fps and segment-local timestamps from 0', () => {
    expect(frameTime(12.5, 0, 30)).toBe(12.5);
    expect(frameTime(12.5, 30, 30)).toBe(13.5);
    expect(frameTimestamp(0, 30)).toBe(0);
    expect(frameTimestamp(45, 30)).toBe(1.5);
    expect(frameCount(10, 20, 24)).toBe(240);
    expect(frameCount(0, 28, 30)).toBe(840);
  });

  it('does not drift on long files (no accumulated error after an hour at 60 fps)', () => {
    const fps = 60;
    const n = 3600 * fps;
    expect(frameTimestamp(n, fps)).toBe(3600);
    let worst = 0;
    for (let k = 0; k <= n; k += 997) worst = Math.max(worst, Math.abs(frameTimestamp(k, fps) - k / fps));
    expect(worst).toBe(0);
    // 25 fps has an exact frame duration of 40 ms
    expect(frameTimestamp(25 * 7200, 25)).toBe(7200);
  });

  it('analyses each frame at the middle of its display interval', () => {
    expect(analysisTime(1, 30)).toBeCloseTo(1 + 1 / 60, 12);
    // an onset exactly between two frames goes to the later one; anything earlier to the earlier one
    const fps = 24;
    const onset = 1.05; // frame 25 is shown 1.0417–1.0833 s
    const firstFrameSeeingIt = Array.from({ length: 60 }, (_, n) => n).find((n) => analysisTime(n / fps, fps) >= onset);
    expect(firstFrameSeeingIt).toBe(25);
  });

  it('pre-rolls up to 3 s before the segment, never before 0', () => {
    expect(preRollStart(10)).toBe(7);
    expect(preRollStart(1)).toBe(0);
  });

  it('trims audio to exact sample ranges', () => {
    expect(audioSampleRange(2.95, 12.95, 48000)).toEqual({ first: 141600, count: 480000 });
    expect(audioSampleRange(0, 1, 44100)).toEqual({ first: 0, count: 44100 });
  });

  it('clamps custom ranges to the track with a minimum length', () => {
    expect(clampRange(-5, 400, 120)).toEqual({ start: 0, end: 120 });
    const r = clampRange(50, 50.1, 120);
    expect(r.end - r.start).toBeGreaterThanOrEqual(0.5);
    const tail = clampRange(119.9, 125, 120);
    expect(tail.end).toBe(120);
    expect(tail.end - tail.start).toBeGreaterThanOrEqual(0.5);
  });
});

describe('offline analysis for exports', () => {
  const SR = 48000;
  const pattern = synthesizeTestPattern(SR, 120);
  // the export uses the same event map the player computed when the file was loaded
  const eventMap = analyzeOffline(pattern.samples, SR).events;

  it('PcmRing keeps a bounded window addressed by absolute sample index', () => {
    const ring = new PcmRing(1000);
    const block = new Float32Array(400).map((_, i) => i + 1);
    for (let k = 0; k < 10; k++) ring.write(k * 400, block);
    expect(ring.end).toBe(4000);
    expect(ring.at(3999)).toBe(400);
    expect(ring.at(3600)).toBe(1);
    expect(ring.at(2999)).toBe(0); // fell out of the window
    expect(ring.at(4000)).toBe(0);
    expect(ring.at(-1)).toBe(0);
    ring.write(5000, new Float32Array([7])); // gap is zero-filled
    expect(ring.at(4500)).toBe(0);
    expect(ring.at(5000)).toBe(7);
  });

  it('PcmAnalyser reproduces the AnalyserNode emulation on streamed chunks', () => {
    const ring = new PcmRing(SR * 8);
    const pcm = new PcmAnalyser(ring, SR, 2048);
    const ref = new FakeAnalyser(pattern.samples, SR, 2048);
    const a = new Float32Array(1024);
    const b = new Float32Array(1024);
    const checks = [4.0, 4.013, 9.5, 23.51];
    let compared = 0;
    // stream the file in chunks and compare as soon as each analysis window is available
    for (let i = 0; i < pattern.samples.length; i += 4410) {
      ring.write(i, pattern.samples.subarray(i, i + 4410));
      for (const t of checks) {
        const end = Math.floor(t * SR);
        if (end > ring.end || end <= ring.end - 4410) continue;
        pcm.seek(t);
        ref.seek(t);
        pcm.getFloatFrequencyData(a);
        ref.getFloatFrequencyData(b);
        for (let k = 0; k < 1024; k += 7) {
          if (Number.isFinite(b[k])) expect(a[k]).toBeCloseTo(b[k], 3);
          else expect(a[k]).toBe(b[k]);
        }
        compared++;
      }
    }
    expect(compared).toBe(checks.length);
  });

  function renderAnalysis(fps: number, start: number, end: number): Float32Array {
    const ring = new PcmRing(SR * 8);
    const analyser = new PcmAnalyser(ring, SR, 2048);
    const ve = virtualEngine(analyser);
    const hub = new AnalysisHub();
    hub.setExportMode(true);
    hub.attach(ve.engine);
    hub.setEventMap(eventMap);
    // feed in uneven chunks, as a decoder would
    const from = Math.round(preRollStart(start) * SR);
    for (let i = from, k = 0; i < Math.round(end * SR) + SR; k++) {
      const n = 3000 + ((k * 7919) % 5000);
      ring.write(i, pattern.samples.subarray(i, i + n));
      i += n;
    }
    const pre = Math.round((start - preRollStart(start)) * fps);
    const total = frameCount(start, end, fps);
    const out = new Float32Array(total * 3);
    let now = 1000;
    for (let n = -pre; n < total; n++) {
      ve.setTime(analysisTime(frameTime(start, n, fps), fps));
      now += 1000 / fps;
      hub.tick(now);
      if (n >= 0) {
        out[n * 3] = hub.frame.bass;
        out[n * 3 + 1] = hub.frame.kick;
        out[n * 3 + 2] = hub.frame.rms;
      }
    }
    return out;
  }

  it('is deterministic: the same segment analyses identically on every run', () => {
    const a = renderAnalysis(30, 5, 9);
    const b = renderAnalysis(30, 5, 9);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('puts kick impulses on the frames nearest the known kick times', () => {
    const fps = 30;
    const start = 2.95;
    const out = renderAnalysis(fps, start, 12.95);
    const kickFrames: number[] = [];
    for (let n = 1; n < out.length / 3; n++) if (out[n * 3 + 1] > 0.5 && out[(n - 1) * 3 + 1] < out[n * 3 + 1] - 0.3) kickFrames.push(n);
    const expected = pattern.kicks.filter((k) => k >= start && k < 12.9).map((k) => k - start);
    expect(kickFrames.length).toBe(expected.length);
    expected.forEach((t, i) => expect(Math.abs(kickFrames[i] / fps - t)).toBeLessThanOrEqual(1 / fps));
  });
});
