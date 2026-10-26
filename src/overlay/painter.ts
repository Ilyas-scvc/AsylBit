/**
 * Draws the stage captions into a video frame: HUD (top left / right), the [NOW] line, the
 * big outlined track title and the compact player (play state, title, file info, whole-track
 * waveform with playhead, time). Same text (model.ts), fonts, colours and proportions as the
 * page — the layout mirrors the CSS in "CSS pixels" scaled to the frame.
 *
 * Order in a frame: the finished scene (with its effects) is drawn first, the captions on
 * top, so post effects never blur or distort the text.
 */
import { eventsLabel, fftLabel, figLabel, HUD_LIGHTS, HUD_METERS, lightOn, mappedStatus, meterFill, meterText, nowLabel, playerSubLabel, playerTitle, readoutLabel, timeLabels, trackProgress, trackTitle, type OverlayFrame, type OverlayTrack } from './model';
import { drawWaveform, WAVE_BASE, WAVE_MARKERS, type WaveformData } from './waveform';

export const OVERLAY_COLORS = {
  fg: '#ecece6',
  fgDim: 'rgba(236,236,230,0.56)',
  fgFaint: 'rgba(236,236,230,0.3)',
  line: 'rgba(236,236,230,0.13)',
  lineStrong: 'rgba(236,236,230,0.3)',
  ink: '#050505',
  /* the player dock: var(--bg) at 86 % */
  panel: 'rgba(5,5,5,0.86)',
  /* -webkit-text-stroke of the title: var(--fg) at 70 % */
  titleStroke: 'rgba(236,236,230,0.7)',
  /* text-shadow of the HUD and [NOW] line: keeps small text legible over bright scenes */
  halo: 'rgba(5,5,5,0.9)',
} as const;

/**
 * Blur of the halo layers in CSS px: text-shadow 0 0 2px, 0 0 6px (global.css) — canvas
 * shadowBlur uses the same scale.
 */
export const HALO_BLURS = [2, 6] as const;

export const MONO_FAMILY = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
export const DISPLAY_FAMILY = '"Archivo Variable", "Archivo", "Arial Narrow", "Helvetica Neue", sans-serif';

export interface FontSpec {
  family: 'mono' | 'display';
  /** px in the frame */
  size: number;
  weight: number;
  /** px in the frame */
  spacing: number;
}

/** Width of `text` in frame pixels. */
export type Measure = (text: string, font: FontSpec) => number;

export interface OverlayContent {
  track: OverlayTrack;
  waveform: WaveformData | null;
  /** scene primary colour (#rrggbb), like --accent on the page */
  accent: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayLayout {
  /** frame pixels per CSS pixel */
  s: number;
  /** HUD: top-left block origin and the right block (right-aligned unless stacked) */
  tl: Rect;
  tr: Rect & { align: 'right' | 'left' };
  title: Rect & { lines: string[]; fontSize: number; kickerY: number };
  player: Rect & { rows: 1 | 2; play: Rect; meta: Rect; wave: Rect; time: Rect };
}

// ---- CSS values (px) ---------------------------------------------------------------------
const CSS = {
  label: 10.5,
  text: 12,
  sub: 9.5,
  lineHeight: 1.5,
  hudInset: 14,
  hudPad: 14,
  hudTop: 12,
  hudGap: 3,
  metersTop: 14,
  meterGap: 7,
  meterCols: [38, 92, 34] as const,
  meterColGap: 8,
  meterTrack: 5,
  lightsTop: 6,
  lightGap: 12,
  lightBox: 7,
  lightInner: 5,
  playerH: 76,
  playerH2: 132,
  playerGap: 18,
  play: 48,
  metaMin: 150,
  metaMax: 230,
  timeline: 46,
  titleGap: 30,
  kickerGap: 10,
  blockGap: 24,
};

const mono = (sizeCss: number, s: number, spacingEm: number, weight = 400): FontSpec => ({ family: 'mono', size: sizeCss * s, weight, spacing: sizeCss * s * spacingEm });

export const FONTS = {
  hud: (s: number) => mono(CSS.label, s, 0.08),
  kicker: (s: number) => mono(CSS.label, s, 0.1),
  playerTitle: (s: number) => mono(CSS.text, s, 0.03, 600),
  playerSub: (s: number) => mono(CSS.sub, s, 0.1),
  time: (s: number) => mono(CSS.text, s, 0.02),
  title: (size: number): FontSpec => ({ family: 'display', size, weight: 820, spacing: -0.012 * size }),
};

/**
 * Frame pixels per CSS pixel. Each format is laid out as the page it will be watched on: a
 * 1440 px wide desktop page for landscape, a 430 px phone page for vertical video and a
 * 640 px page for square — so captions stay readable at the size the video is shown.
 */
export function overlayScale(width: number, height: number): number {
  const aspect = width / height;
  const cssWidth = aspect >= 1.3 ? 1440 : aspect <= 0.8 ? 430 : 640;
  return width / cssWidth;
}

/** Vertical frames follow the page's phone rules (stacked HUD, two-row player, 13vw title). */
export function isPhoneFrame(width: number, height: number): boolean {
  return width / height <= 0.8;
}

/** Split a title into at most two lines that fit `maxWidth` (overflow-wrap: anywhere; ellipsis on line 2). */
export function wrapTitle(text: string, maxWidth: number, font: FontSpec, measure: Measure): string[] {
  const fits = (t: string) => measure(t, font) <= maxWidth;
  const lines: string[] = [];
  let rest = text.trim();
  while (rest && lines.length < 2) {
    if (fits(rest)) {
      lines.push(rest);
      rest = '';
      break;
    }
    // longest prefix that fits, preferring a break at a space
    let n = rest.length;
    while (n > 1 && !fits(rest.slice(0, n))) n--;
    const space = rest.lastIndexOf(' ', n);
    const cut = space > 0 && lines.length === 0 ? space : n;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest && lines.length === 2) lines[1] = ellipsize(`${lines[1]} ${rest}`, maxWidth, font, measure);
  return lines;
}

export function ellipsize(text: string, maxWidth: number, font: FontSpec, measure: Measure): string {
  if (measure(text, font) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid)}…`, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/**
 * The title size of .hero-word-outline: clamp(34px, min(9vw, 14vh) · k, 150px) on wide pages,
 * clamp(38px, 13vw, 90px) for vertical frames (as the page's phone media query).
 */
export function titleSize(width: number, height: number, s: number, k: number): number {
  const vw = width / s / 100;
  const vh = height / s / 100;
  if (isPhoneFrame(width, height)) return Math.min(90, Math.max(38, 13 * vw)) * s;
  return Math.min(150, Math.max(34, Math.min(9 * vw, 14 * vh) * k)) * s;
}

/** Geometry of all blocks for a frame size; texts that set widths come from `sample`. */
export function layoutOverlay(width: number, height: number, content: OverlayContent, sample: OverlayFrame, measure: Measure): OverlayLayout {
  const s = overlayScale(width, height);
  const px = (v: number) => v * s;
  const cssW = width / s;
  const narrow = isPhoneFrame(width, height);
  const g = narrow ? px(16) : px(Math.min(32, Math.max(16, 0.022 * cssW)));
  const line = px(CSS.label * CSS.lineHeight);
  const hud = FONTS.hud(s);

  // ---- HUD, top left (phone pages: 10 px insets, as the page's media query)
  const tlX = narrow ? px(20) : g + px(CSS.hudPad);
  const tlY = narrow ? px(20) : px(CSS.hudInset + CSS.hudTop);
  const rangeW = Math.max(...HUD_METERS.map((m) => measure(m.range, hud)));
  const meterW = px(CSS.meterCols[0] + CSS.meterCols[1] + CSS.meterCols[2] + 3 * CSS.meterColGap) + rangeW;
  const lightsW = HUD_LIGHTS.reduce((w, l) => w + px(CSS.lightBox + CSS.lightInner) + measure(l.label, hud), 0) + px(CSS.lightGap) * (HUD_LIGHTS.length - 1);
  const tlW = Math.max(measure(figLabel(sample.sceneIndex, sample.sceneName), hud), measure(readoutLabel(-180, -90, 60), hud), meterW, lightsW);
  const tlH = 2 * line + px(CSS.hudGap) + px(CSS.metersTop) + 3 * line + 3 * px(CSS.meterGap) + px(CSS.lightsTop) + line;
  const tl: Rect = { x: tlX, y: tlY, w: tlW, h: tlH };

  // ---- HUD, top right (stacked under the left block when they would touch)
  const trW = Math.max(measure(fftLabel(sample.fftSize, sample.sampleRate), hud), measure(eventsLabel(eventsState(content.track)), hud));
  const trH = 2 * line + px(CSS.hudGap);
  const trRight = narrow ? width - px(20) : width - g - px(CSS.hudPad);
  const side = trRight - trW >= tlX + tlW + px(CSS.blockGap);
  const tr = side ? { x: trRight - trW, y: tlY, w: trW, h: trH, align: 'right' as const } : { x: tlX, y: tlY + tlH + px(CSS.meterGap * 2), w: trW, h: trH, align: 'left' as const };

  // ---- player
  const timeW = measure(`${timeLabels(content.track.duration, content.track.duration).now}${timeLabels(0, content.track.duration).total}`, FONTS.time(s));
  const inner = width - 2 * g;
  const meta = Math.min(px(CSS.metaMax), Math.max(px(CSS.metaMin), inner * 0.22));
  const waveOneRow = inner - px(CSS.play) - meta - timeW - 3 * px(CSS.playerGap);
  const rows: 1 | 2 = !narrow && waveOneRow >= px(160) ? 1 : 2;
  const playerH = px(rows === 1 ? CSS.playerH : CSS.playerH2);
  const pY = height - playerH;
  let play: Rect;
  let metaR: Rect;
  let wave: Rect;
  let time: Rect;
  if (rows === 1) {
    const cy = pY + playerH / 2;
    play = { x: g, y: cy - px(CSS.play) / 2, w: px(CSS.play), h: px(CSS.play) };
    metaR = { x: play.x + play.w + px(CSS.playerGap), y: cy - px(16), w: meta, h: px(32) };
    wave = { x: metaR.x + meta + px(CSS.playerGap), y: cy - px(CSS.timeline) / 2, w: waveOneRow, h: px(CSS.timeline) };
    time = { x: wave.x + wave.w + px(CSS.playerGap), y: cy - px(9), w: timeW, h: px(18) };
  } else {
    // narrow frames: play · title · time on top, the waveform across the full width below
    const top = pY + px(10);
    play = { x: g, y: top, w: px(CSS.play), h: px(CSS.play) };
    time = { x: width - g - timeW, y: top + px(15), w: timeW, h: px(18) };
    metaR = { x: play.x + play.w + px(12), y: top + px(8), w: Math.max(0, time.x - px(12) - (play.x + play.w + px(12))), h: px(32) };
    wave = { x: g, y: top + px(CSS.play) + px(6), w: inner, h: px(36) };
  }
  const player = { x: 0, y: pY, w: width, h: playerH, rows, play, meta: metaR, wave, time };

  // ---- title + [NOW] line, above the player
  const t = trackTitle(content.track.name);
  // phone pages: the title spans the width between 22 px insets
  const titleX = narrow ? px(22) : tlX;
  const maxW = narrow ? width - px(44) : Math.min(0.64 * width, px(900), width - tlX - g);
  let fontSize = titleSize(width, height, s, t.k);
  let lines = wrapTitle(t.text.toUpperCase(), maxW, FONTS.title(fontSize), measure);
  const bottom = pY - px(CSS.titleGap);
  const kickerH = line + px(CSS.kickerGap);
  // never run into the HUD: shrink the title if the frame is too short for it
  const hudBottom = Math.max(tl.y + tl.h, tr.y + tr.h) + px(CSS.blockGap);
  while (fontSize > px(20) && bottom - lines.length * fontSize * 0.8 - fontSize * 0.06 - kickerH < hudBottom) {
    fontSize *= 0.9;
    lines = wrapTitle(t.text.toUpperCase(), maxW, FONTS.title(fontSize), measure);
  }
  const titleH = lines.length * fontSize * 0.8 + fontSize * 0.06;
  const titleTop = bottom - titleH;
  const titleW = Math.max(...lines.map((l) => measure(l, FONTS.title(fontSize))), measure(nowLabel(content.track.extension, content.track.duration), FONTS.kicker(s)));
  const title = { x: titleX, y: titleTop - kickerH, w: titleW, h: titleH + kickerH, lines, fontSize, kickerY: titleTop - kickerH };

  return { s, tl, tr, title, player };
}

function eventsState(track: OverlayTrack) {
  return track.mapped ? { kind: 'mapped' as const, events: track.mapped.events, bpm: track.mapped.bpm } : { kind: 'realtime' as const };
}

// ---- drawing --------------------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

export function fontString(f: FontSpec): string {
  return `${f.weight} ${f.size.toFixed(2)}px ${f.family === 'mono' ? MONO_FAMILY : DISPLAY_FAMILY}`;
}

export function applyFont(ctx: Ctx2D, f: FontSpec): void {
  ctx.font = fontString(f);
  const c = ctx as Ctx2D & { letterSpacing?: string; fontStretch?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${f.spacing.toFixed(2)}px`;
  if ('fontStretch' in c) c.fontStretch = f.family === 'display' ? 'extra-condensed' : 'normal';
}

/** Measure with a real canvas context (fonts must be loaded). */
export function canvasMeasure(ctx: Ctx2D): Measure {
  return (text, font) => {
    applyFont(ctx, font);
    return ctx.measureText(text).width;
  };
}

function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha.toFixed(3)})`;
}

export class OverlayPainter {
  private layout: OverlayLayout | null = null;
  private base: CanvasLike | null = null;
  private played: CanvasLike | null = null;
  private readonly ellipsized = new Map<string, string>();

  constructor(
    readonly width: number,
    readonly height: number,
    readonly content: OverlayContent,
    private readonly measure: Measure,
    private readonly createCanvas: (w: number, h: number) => CanvasLike,
  ) {}

  /** Geometry (computed on the first frame: it depends on the analyser actually used). */
  layoutFor(frame: OverlayFrame): OverlayLayout {
    this.layout ??= layoutOverlay(this.width, this.height, this.content, frame, this.measure);
    return this.layout;
  }

  /** The whole-track waveform, rendered once at the player's size: base and played colour. */
  private waveLayers(l: OverlayLayout): [CanvasLike, CanvasLike] {
    if (!this.base || !this.played) {
      const w = Math.max(1, Math.round(l.player.wave.w));
      const h = Math.max(1, Math.round(l.player.wave.h));
      const make = (color: string, markers: string) => {
        const c = this.createCanvas(w, h);
        const g = c.getContext('2d') as Ctx2D | null;
        if (g) drawWaveform(g as CanvasRenderingContext2D, w, h, Math.max(1, l.s), this.content.waveform, color, markers, true);
        return c;
      };
      this.base = make(WAVE_BASE, WAVE_MARKERS);
      this.played = make(this.content.accent, this.content.accent);
    }
    return [this.base, this.played];
  }

  private fit(text: string, maxWidth: number, font: FontSpec): string {
    const key = `${font.size}|${maxWidth}|${text}`;
    let out = this.ellipsized.get(key);
    if (out === undefined) {
      out = ellipsize(text, maxWidth, font, this.measure);
      this.ellipsized.set(key, out);
    }
    return out;
  }

  draw(ctx: Ctx2D, frame: OverlayFrame): void {
    const l = this.layoutFor(frame);
    const { s } = l;
    const C = OVERLAY_COLORS;
    const accent = this.content.accent;
    const line = CSS.label * CSS.lineHeight * s;
    const hud = FONTS.hud(s);
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
    /**
     * The halo behind HUD, [NOW] and title text (boxes and the player have none, as on the
     * page). Like CSS text-shadow, each layer is a shadow alone, at its own opacity: the glyphs
     * are filled off-frame (opaque) with the shadow offset back onto the text position.
     */
    const away = 2 * (this.width + this.height);
    const halo = (str: string, x: number, y: number) => {
      const fill = ctx.fillStyle;
      ctx.fillStyle = '#000';
      ctx.shadowColor = C.halo;
      ctx.shadowOffsetX = away;
      for (const blur of HALO_BLURS) {
        ctx.shadowBlur = blur * s;
        ctx.fillText(str, x - away, y);
      }
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.fillStyle = fill;
    };
    const text = (str: string, x: number, y: number) => {
      halo(str, x, y);
      ctx.fillText(str, x, y);
    };

    // ---- HUD, top left
    applyFont(ctx, hud);
    let y = l.tl.y + line / 2;
    ctx.fillStyle = C.fg;
    text(figLabel(frame.sceneIndex, frame.sceneName), l.tl.x, y);
    y += line + CSS.hudGap * s;
    ctx.fillStyle = C.fgDim;
    text(readoutLabel(frame.rotation, frame.tilt, frame.fps), l.tl.x, y);
    y += line + CSS.hudGap * s + CSS.metersTop * s - CSS.hudGap * s;
    for (let i = 0; i < HUD_METERS.length; i++) {
      const m = HUD_METERS[i];
      let x = l.tl.x;
      ctx.fillStyle = C.fg;
      text(m.label, x, y);
      x += (CSS.meterCols[0] + CSS.meterColGap) * s;
      const tw = CSS.meterCols[1] * s;
      const th = CSS.meterTrack * s;
      ctx.strokeStyle = C.lineStrong;
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(x + ctx.lineWidth / 2, y - th / 2, tw - ctx.lineWidth, th);
      ctx.fillStyle = accent;
      ctx.fillRect(x + ctx.lineWidth, y - th / 2 + ctx.lineWidth / 2, (tw - 2 * ctx.lineWidth) * meterFill(frame.levels[i]), th - ctx.lineWidth);
      x += tw + CSS.meterColGap * s;
      ctx.fillStyle = C.fgDim;
      text(meterText(frame.levels[i]), x, y);
      x += (CSS.meterCols[2] + CSS.meterColGap) * s;
      ctx.fillStyle = C.fgFaint;
      text(m.range, x, y);
      y += line + CSS.meterGap * s;
    }
    y += CSS.lightsTop * s;
    let lx = l.tl.x;
    for (let i = 0; i < HUD_LIGHTS.length; i++) {
      const on = lightOn(frame.lights[i]);
      const box = CSS.lightBox * s;
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeStyle = C.fgFaint;
      ctx.strokeRect(lx + ctx.lineWidth / 2, y - box / 2, box - ctx.lineWidth, box - ctx.lineWidth);
      if (on > 0) {
        ctx.fillStyle = withAlpha(accent, on);
        ctx.fillRect(lx, y - box / 2, box, box);
        ctx.strokeStyle = withAlpha(accent, on);
        ctx.strokeRect(lx + ctx.lineWidth / 2, y - box / 2, box - ctx.lineWidth, box - ctx.lineWidth);
      }
      lx += box + CSS.lightInner * s;
      ctx.fillStyle = `rgba(236,236,230,${(0.45 + on * 0.55).toFixed(3)})`;
      const label = HUD_LIGHTS[i].label;
      text(label, lx, y);
      lx += this.measure(label, hud) + CSS.lightGap * s;
    }

    // ---- HUD, top right
    ctx.textAlign = l.tr.align === 'right' ? 'right' : 'left';
    const trX = l.tr.align === 'right' ? l.tr.x + l.tr.w : l.tr.x;
    ctx.fillStyle = C.fg;
    text(fftLabel(frame.fftSize, frame.sampleRate), trX, l.tr.y + line / 2);
    ctx.fillStyle = C.fgDim;
    text(eventsLabel(eventsState(this.content.track)), trX, l.tr.y + line * 1.5 + CSS.hudGap * s);
    ctx.textAlign = 'left';

    // ---- [NOW] line and outlined title
    const track = this.content.track;
    applyFont(ctx, FONTS.kicker(s));
    ctx.fillStyle = C.fgDim;
    text(nowLabel(track.extension, track.duration), l.title.x, l.title.kickerY + line / 2);
    const tf = FONTS.title(l.title.fontSize);
    applyFont(ctx, tf);
    ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = C.titleStroke;
    ctx.lineWidth = Math.max(1, s);
    ctx.lineJoin = 'round';
    let ty = l.title.kickerY + line + CSS.kickerGap * s;
    for (const text of l.title.lines) {
      // line-height 0.8: the cap height fills the line box
      ty += l.title.fontSize * 0.8;
      halo(text, l.title.x, ty - l.title.fontSize * 0.06);
      ctx.strokeText(text, l.title.x, ty - l.title.fontSize * 0.06);
    }
    ctx.textBaseline = 'middle';

    // ---- player
    const p = l.player;
    ctx.fillStyle = C.panel;
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = C.line;
    ctx.fillRect(p.x, p.y, p.w, Math.max(1, s));
    // play state: in a video the track is always playing (filled button, pause bars)
    const b = p.play;
    if (frame.playing) {
      ctx.fillStyle = accent;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    } else {
      ctx.strokeStyle = C.fg;
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(b.x + ctx.lineWidth / 2, b.y + ctx.lineWidth / 2, b.w - ctx.lineWidth, b.h - ctx.lineWidth);
    }
    const icon = 20 * s;
    const ix = b.x + (b.w - icon) / 2;
    const iy = b.y + (b.h - icon) / 2;
    const u = icon / 20;
    ctx.fillStyle = frame.playing ? C.ink : C.fg;
    if (frame.playing) {
      ctx.fillRect(ix + 6 * u, iy + 4.5 * u, 2.5 * u, 11 * u);
      ctx.fillRect(ix + 11.5 * u, iy + 4.5 * u, 2.5 * u, 11 * u);
    } else {
      ctx.beginPath();
      ctx.moveTo(ix + 6 * u, iy + 4.5 * u);
      ctx.lineTo(ix + 6 * u, iy + 15.5 * u);
      ctx.lineTo(ix + 15 * u, iy + 10 * u);
      ctx.closePath();
      ctx.fill();
    }
    // title + file info
    const tFont = FONTS.playerTitle(s);
    applyFont(ctx, tFont);
    ctx.fillStyle = C.fg;
    ctx.fillText(this.fit(playerTitle(track.name), p.meta.w, tFont), p.meta.x, p.meta.y + p.meta.h * 0.3);
    const sFont = FONTS.playerSub(s);
    applyFont(ctx, sFont);
    ctx.fillStyle = C.fgDim;
    const sub = playerSubLabel(track.extension, track.size, frame.sampleRate, track.mapped ? mappedStatus(track.mapped.counts) : 'REAL-TIME ONLY');
    ctx.fillText(this.fit(sub, p.meta.w, sFont), p.meta.x, p.meta.y + p.meta.h * 0.78);
    // waveform: cached base, played part in the accent, playhead at the absolute track position
    const [base, played] = this.waveLayers(l);
    const w = p.wave;
    const progress = trackProgress(frame.time, track.duration);
    ctx.drawImage(base, w.x, w.y, w.w, w.h);
    const pw = Math.round(w.w * progress);
    if (pw > 0) ctx.drawImage(played, 0, 0, Math.min(pw, (played as { width: number }).width), (played as { height: number }).height, w.x, w.y, Math.min(pw, w.w), w.h);
    const hx = Math.round(w.x + w.w * progress);
    ctx.fillStyle = C.fg;
    ctx.fillRect(hx, w.y - 4 * s, Math.max(1, s), w.h + 8 * s);
    ctx.fillRect(hx - 3 * s, w.y - 4 * s, 7 * s, 7 * s);
    // time
    const time = timeLabels(frame.time, track.duration);
    const fFont = FONTS.time(s);
    applyFont(ctx, fFont);
    ctx.fillStyle = C.fg;
    ctx.fillText(time.now, p.time.x, p.time.y + p.time.h / 2);
    ctx.fillStyle = C.fgDim;
    ctx.fillText(time.total, p.time.x + this.measure(time.now, fFont), p.time.y + p.time.h / 2);

    ctx.restore();
  }
}

/** Fonts the overlay draws with, loaded (with the glyphs of `text`) before the first frame. */
export async function loadOverlayFonts(text: string): Promise<void> {
  const set = typeof document === 'undefined' ? undefined : document.fonts;
  if (!set) return;
  const sample = text || 'BEAT//FORM';
  await Promise.all([
    set.load(`400 12px ${MONO_FAMILY}`, sample),
    set.load(`600 12px ${MONO_FAMILY}`, sample),
    set.load(`820 64px ${DISPLAY_FAMILY}`, sample.toUpperCase()),
  ]);
  await set.ready;
}

/** A painter for a frame size, measuring with a real canvas. */
export function createOverlayPainter(width: number, height: number, content: OverlayContent): OverlayPainter {
  const scratch = document.createElement('canvas').getContext('2d');
  if (!scratch) throw new Error('2D canvas is not available');
  return new OverlayPainter(width, height, content, canvasMeasure(scratch), (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  });
}
