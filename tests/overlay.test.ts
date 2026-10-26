/**
 * Stage captions (HUD, [NOW] line, outlined title, compact player): the shared text model, the
 * frame layout for every export format and what the painter draws. Text widths come from a
 * deterministic stand-in for canvas measureText, so layouts are checked for geometry (inside
 * the frame, no overlaps, at most two title lines) — the real glyphs are checked in the browser.
 */
import { describe, expect, it } from 'vitest';
import { recordingContext, type DrawCall as Call } from './helpers';
import { sceneRegistry } from '../src/engine/scenes/registry';
import { eventsLabel, fftLabel, figLabel, mappedStatus, nowLabel, playerSubLabel, readoutLabel, timeLabels, trackProgress, trackTitle, type OverlayFrame } from '../src/overlay/model';
import { FONTS, isPhoneFrame, layoutOverlay, OverlayPainter, overlayScale, wrapTitle, type FontSpec, type OverlayContent, type OverlayLayout, type Rect } from '../src/overlay/painter';

/** Monospace glyphs are 0.6 em, the condensed display face ~0.55 em (wide Cyrillic capitals). */
const measure = (text: string, f: FontSpec) => [...text].length * (f.size * (f.family === 'mono' ? 0.6 : 0.55) + f.spacing);

const FORMATS: [number, number][] = [
  [1280, 720],
  [1920, 1080],
  [3840, 2160],
  [720, 1280],
  [1080, 1920],
  [2160, 3840],
  [720, 720],
  [1080, 1080],
];

const NAMES = [
  'kick.wav',
  'night_drive_final_master.mp3',
  'A very long track name with many words (Extended Club Mix) 2026 remaster.flac',
  'Очень длинное название трека — ночной эфир (extended mix) 2026.wav',
  'ЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖЖ.ogg',
];

function content(name: string, duration = 28): OverlayContent {
  const extension = name.split('.').pop() ?? '';
  return {
    track: { name, extension, size: 4_928_307, duration, mapped: { events: 102, bpm: 120, counts: [32, 16, 54, 0] } },
    waveform: null,
    accent: '#d4ff3a',
  };
}

function frame(over: Partial<OverlayFrame> = {}): OverlayFrame {
  return {
    sceneIndex: '05',
    sceneName: 'COSMIC RINGS',
    rotation: 18.6,
    tilt: 0,
    fps: 30,
    levels: [0.4, 0.35, 0.08],
    lights: [0.7, 0, 0.2, 0],
    fftSize: 2048,
    sampleRate: 48000,
    time: 9.5,
    playing: true,
    ...over,
  };
}

const EPS = 0.5;
const inside = (r: Rect, w: number, h: number) => r.x >= -EPS && r.y >= -EPS && r.x + r.w <= w + EPS && r.y + r.h <= h + EPS;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

describe('caption text — one source for the page and the video', () => {
  it('formats the HUD exactly as the page shows it', () => {
    expect(figLabel('05', 'COSMIC RINGS')).toBe('FIG. 05 — COSMIC RINGS');
    expect(readoutLabel(18.6, 0, 60)).toBe('[ROT 018.6°] [TILT 0.0°] [FPS 60]');
    // scenes report rotation wrapped to 0..360°
    expect(readoutLabel(4.25, -2.5, null)).toBe('[ROT 004.3°] [TILT -2.5°] [FPS —]');
    expect(fftLabel(2048, 48000)).toBe('FFT 2048 · 48.0 KHZ · 23.4 HZ/BIN');
    expect(fftLabel(4096, 44100)).toBe('FFT 4096 · 44.1 KHZ · 10.8 HZ/BIN');
    expect(eventsLabel({ kind: 'mapped', events: 102, bpm: 120 })).toBe('EVENTS: MAPPED · 102 · ≈120 BPM');
    expect(eventsLabel({ kind: 'mapped', events: 3, bpm: null })).toBe('EVENTS: MAPPED · 3');
  });

  it('formats the [NOW] line, title and player like the page', () => {
    expect(nowLabel('wav', 28)).toBe('[NOW] WAV · 00:28 · LOCAL FILE');
    expect(trackTitle('night_drive.wav')).toEqual({ text: 'night drive', k: 1 });
    const long = trackTitle('Очень длинное название трека — ночной эфир (extended mix) 2026.wav');
    expect(long.text).toHaveLength(40);
    expect(long.text.endsWith('…')).toBe(true);
    expect(long.k).toBeGreaterThanOrEqual(0.42);
    expect(playerSubLabel('wav', 4_928_307, 48000, mappedStatus([32, 16, 54, 0]))).toBe('WAV · 4.7 MB · 48.0 KHZ · MAPPED 32K/16S/54H');
    expect(timeLabels(9.53, 28)).toEqual({ now: '00:09.5', total: ' / 00:28.0' });
    expect(timeLabels(83.99, 200).now).toBe('01:23.9');
  });

  it('places the playhead on the whole track, clamped', () => {
    expect(trackProgress(7, 28)).toBe(0.25);
    expect(trackProgress(-1, 28)).toBe(0);
    expect(trackProgress(40, 28)).toBe(1);
    expect(trackProgress(3, 0)).toBe(0);
  });
});

describe('caption layout — 16:9, 9:16 and 1:1', () => {
  const titleMaxW = (l: OverlayLayout, w: number) => w - l.title.x;

  for (const [w, h] of FORMATS) {
    it(`${w}×${h}: every block inside the frame, nothing overlapping, for all scenes and names`, () => {
      for (const def of sceneRegistry.list()) {
        for (const name of NAMES) {
          const c = content(name);
          const l = layoutOverlay(w, h, c, frame({ sceneIndex: def.index, sceneName: def.name }), measure);
          const where = `${def.name} / ${name}`;
          for (const [key, r] of Object.entries({ tl: l.tl, tr: l.tr, title: l.title, player: l.player })) {
            expect(inside(r, w, h), `${key} inside — ${where}`).toBe(true);
          }
          expect(overlaps(l.tl, l.tr), `HUD blocks — ${where}`).toBe(false);
          expect(l.title.y, `title under the HUD — ${where}`).toBeGreaterThanOrEqual(Math.max(l.tl.y + l.tl.h, l.tr.y + l.tr.h) - EPS);
          expect(l.title.y + l.title.h, `title above the player — ${where}`).toBeLessThanOrEqual(l.player.y + EPS);
          // the title: one or two lines, each fitting the frame
          expect(l.title.lines.length).toBeGreaterThanOrEqual(1);
          expect(l.title.lines.length).toBeLessThanOrEqual(2);
          for (const line of l.title.lines) expect(measure(line, FONTS.title(l.title.fontSize))).toBeLessThanOrEqual(titleMaxW(l, w));
          // the player's parts sit inside it and apart
          const p = l.player;
          const parts = { play: p.play, meta: p.meta, wave: p.wave, time: p.time };
          for (const [key, r] of Object.entries(parts)) expect(inside(r, w, h) && r.y >= p.y - EPS, `${key} — ${where}`).toBe(true);
          const list = Object.values(parts);
          for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) expect(overlaps(list[i], list[j]), `player parts — ${where}`).toBe(false);
        }
      }
    });
  }

  it('keeps captions readable: label text scales with the frame', () => {
    for (const [w, h] of FORMATS) {
      const s = overlayScale(w, h);
      expect(FONTS.hud(s).size, `${w}×${h}`).toBeGreaterThanOrEqual(0.0125 * Math.min(w, h));
    }
  });

  it('scales a layout exactly with the resolution (same picture at 720p and 2160p)', () => {
    const c = content('night_drive_final_master.mp3');
    const a = layoutOverlay(1280, 720, c, frame(), measure);
    const b = layoutOverlay(3840, 2160, c, frame(), measure);
    expect(b.s / a.s).toBeCloseTo(3, 9);
    expect(b.title.fontSize / a.title.fontSize).toBeCloseTo(3, 9);
    expect(b.player.h / a.player.h).toBeCloseTo(3, 9);
    expect(b.title.lines).toEqual(a.title.lines);
  });

  it('reflows narrow frames: vertical video stacks the HUD and splits the player in two rows', () => {
    const c = content('Очень длинное название трека — ночной эфир (extended mix) 2026.wav');
    const wide = layoutOverlay(1920, 1080, c, frame(), measure);
    expect(wide.tr.align).toBe('right');
    expect(wide.player.rows).toBe(1);
    expect(isPhoneFrame(1080, 1920)).toBe(true);
    const tall = layoutOverlay(1080, 1920, c, frame(), measure);
    expect(tall.tr.align).toBe('left');
    expect(tall.tr.y).toBeGreaterThan(tall.tl.y + tall.tl.h);
    expect(tall.player.rows).toBe(2);
    // the waveform spans the width under play · title · time
    expect(tall.player.wave.y).toBeGreaterThanOrEqual(tall.player.play.y + tall.player.play.h);
    expect(isPhoneFrame(1080, 1080)).toBe(false);
  });

  it('breaks long titles at spaces, two lines at most, with an ellipsis', () => {
    const f = FONTS.title(100);
    expect(wrapTitle('NIGHT DRIVE', 10_000, f, measure)).toEqual(['NIGHT DRIVE']);
    const lines = wrapTitle('ОЧЕНЬ ДЛИННОЕ НАЗВАНИЕ ТРЕКА — НОЧНОЙ ЭФИР', 700, f, measure);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('ОЧЕНЬ ДЛИННОЕ'); // broken at a space, not inside a word
    expect(lines[1].endsWith('…')).toBe(true);
    for (const l of lines) expect(measure(l, f)).toBeLessThanOrEqual(700);
    // one unbreakable word: split anywhere, as overflow-wrap: anywhere
    const word = wrapTitle('Ж'.repeat(40), 700, f, measure);
    expect(word).toHaveLength(2);
    for (const l of word) expect(measure(l, f)).toBeLessThanOrEqual(700);
  });
});

describe('OverlayPainter', () => {
  function painter(name = 'night_drive.wav', w = 1920, h = 1080) {
    let layers = 0;
    const p = new OverlayPainter(w, h, content(name), measure, (cw, ch) => {
      layers++;
      const calls: Call[] = [];
      return { width: cw, height: ch, getContext: () => recordingContext(calls) } as unknown as HTMLCanvasElement;
    });
    return { p, layers: () => layers };
  }

  it('draws every caption with the frame values', () => {
    const { p } = painter();
    const calls: Call[] = [];
    p.draw(recordingContext(calls), frame({ time: 9.5, fps: 60, rotation: 271.25, tilt: -3 }));
    const texts = calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);
    expect(texts).toEqual(
      expect.arrayContaining([
        'FIG. 05 — COSMIC RINGS',
        '[ROT 271.3°] [TILT -3.0°] [FPS 60]',
        'BASS',
        '0.40',
        '20–150 HZ',
        'KICK',
        'TONE',
        'FFT 2048 · 48.0 KHZ · 23.4 HZ/BIN',
        'EVENTS: MAPPED · 102 · ≈120 BPM',
        '[NOW] WAV · 00:28 · LOCAL FILE',
        'night_drive',
        '00:09.5',
        ' / 00:28.0',
      ]),
    );
    // the file line is shortened to the meta column, as text-overflow: ellipsis on the page
    expect(texts.find((t) => String(t).startsWith('WAV · 4.7 MB · 48.0 KHZ'))).toBeDefined();
    const outlined = calls.filter((c) => c.op === 'strokeText').map((c) => c.args[0]);
    expect(outlined).toEqual(['NIGHT DRIVE']);
  });

  it('puts the playhead at the absolute track position and caches the waveform layers', () => {
    const { p, layers } = painter();
    const l = p.layoutFor(frame());
    const w = l.player.wave;
    for (const time of [0, 7, 21, 28]) {
      const calls: Call[] = [];
      p.draw(recordingContext(calls), frame({ time }));
      const head = calls.find((c) => c.op === 'fillRect' && c.args[3] === w.h + 8 * l.s);
      expect(head?.args[0]).toBe(Math.round(w.x + w.w * (time / 28)));
      const played = calls.filter((c) => c.op === 'drawImage' && c.args.length === 9);
      if (time === 0) expect(played).toHaveLength(0);
      else expect(played[0].args[3]).toBe(Math.min(Math.round(w.w * (time / 28)), Math.round(w.w)));
    }
    expect(layers()).toBe(2); // base + played, rendered once
  });

  it('draws the HUD halo as shadow-only layers, leaving the text colour and the player untouched', () => {
    const { p } = painter();
    const calls: Call[] = [];
    p.draw(recordingContext(calls), frame());
    const l = p.layoutFor(frame());
    const fig = calls.filter((c) => c.op === 'fillText' && c.args[0] === 'FIG. 05 — COSMIC RINGS');
    const away = 2 * (1920 + 1080);
    // two halo layers (2 px, 6 px) drawn off-frame and shifted back, then the text itself
    expect(fig.map((c) => [c.args[1], c.shadow, c.fillStyle])).toEqual([
      [l.tl.x - away, [2 * l.s, away], '#000'],
      [l.tl.x - away, [6 * l.s, away], '#000'],
      [l.tl.x, undefined, '#ecece6'],
    ]);
    const title = calls.filter((c) => c.op === 'fillText' && c.args[0] === 'night_drive');
    expect(title).toHaveLength(1);
    expect(title[0].shadow).toBeUndefined();
    // meter boxes carry no shadow either
    expect(calls.filter((c) => c.op === 'strokeRect' || c.op === 'fillRect').every((c) => !c.shadow)).toBe(true);
  });

  it('draws the paused state as an outlined play button', () => {
    const { p } = painter();
    const calls: Call[] = [];
    p.draw(recordingContext(calls), frame({ playing: false }));
    const b = p.layoutFor(frame()).player.play;
    expect(calls.some((c) => c.op === 'fillRect' && c.args[0] === b.x && c.args[2] === b.w)).toBe(false);
    expect(calls.some((c) => c.op === 'strokeRect')).toBe(true);
  });
});
