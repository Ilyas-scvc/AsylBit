/**
 * SPINNING DISC: the scene, the global disc settings (storage, presets, links), TOGGLE DISC,
 * the composition per frame format, and the disc renderer's behaviour — spin, audio reaction,
 * artwork textures and clean-up. three.js objects are real; nothing here needs a GPU.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DiscLayer, type DiscFrame } from '../src/engine/disc/DiscLayer';
import {
  artworkFit,
  CASE_SIZE,
  defaultDiscSettings,
  DISC_PARAMS,
  DISC_SCENE_ID,
  discPlacement,
  discVisible,
  sanitizeDisc,
  toggleDisc,
  type DiscArtwork,
} from '../src/engine/disc/settings';
import { createSceneAudio } from '../src/engine/features';
import { getSceneSchema } from '../src/engine/params';
import { BUILTIN_PRESETS, builtinForScene } from '../src/engine/presets/builtins';
import { decodePresetFromUrl, encodePresetForUrl, makePreset, migratePreset, presetToJson, presetsFromJson } from '../src/engine/presets/schema';
import { getScene, sceneRegistry } from '../src/engine/scenes/registry';
import type { ParamValues, SceneAudio } from '../src/engine/types';
import { appUiClasses, useUi } from '../src/state/ui';
import { selectScene, useVisual, visualSnapshot } from '../src/state/visual';

const palette = { primary: new THREE.Color(0.5, 0.8, 1), secondary: new THREE.Color(1, 0.4, 0.8), background: new THREE.Color(0, 0, 0), gradient: 1 };

function frame(settings: ParamValues, over: Partial<DiscFrame> = {}): DiscFrame {
  return { dt: 1 / 60, clock: 0, audio: createSceneAudio(), palette, width: 1920, height: 1080, settings, reducedMotion: false, ...over };
}

/** Advance `layer` for `seconds` at `fps`; `audioAt` sets the audio of each frame. */
function run(layer: DiscLayer, settings: ParamValues, fps: number, seconds: number, audioAt?: (t: number, a: SceneAudio) => void, probe?: (t: number) => void) {
  const audio = createSceneAudio();
  const f = frame(settings, { dt: 1 / fps, audio });
  const n = Math.round(seconds * fps);
  for (let i = 1; i <= n; i++) {
    const t = i / fps;
    f.clock = t;
    audioAt?.(t, audio);
    layer.update(f);
    probe?.(t);
  }
}

/** Music with a kick every 0.5 s between 1 s and 7 s. */
function music(t: number, a: SceneAudio) {
  const on = t >= 1 && t < 7;
  a.activity = on ? 1 : 0;
  a.rms = on ? 0.55 + 0.1 * Math.sin(t * 3) : 0;
  a.bass = on ? 0.5 + 0.4 * Math.sin(t * Math.PI * 2) : 0;
  a.sub = a.bass;
  a.mids = on ? 0.45 : 0;
  a.treble = on ? 0.6 : 0;
  const kicks = on ? Math.floor((t - 1) / 0.5) + 1 : t >= 7 ? 12 : 0;
  if (kicks !== a.kickCount) {
    a.kickCount = kicks;
    a.kickPeak = 1;
  }
}

const uniforms = (layer: DiscLayer) => (layer as unknown as { faceMat: THREE.ShaderMaterial }).faceMat.uniforms;
const placeScale = (layer: DiscLayer) => (layer as unknown as { place: THREE.Group }).place.scale.x;

describe('SCENE 10 — SPINNING DISC', () => {
  it('is registered as scene 10 with a valid schema and built-in presets', () => {
    const def = getScene(DISC_SCENE_ID);
    expect(def.index).toBe('10');
    expect(def.name).toBe('SPINNING DISC');
    expect(sceneRegistry.list().at(-1)?.id).toBe(DISC_SCENE_ID);
    expect(getSceneSchema(def).length).toBeGreaterThan(5);
    // visiting the scene loads SPIN, which leaves the user's disc as it is
    expect(builtinForScene(DISC_SCENE_ID)?.disc).toBeUndefined();
    const holo = BUILTIN_PRESETS.find((p) => p.id === 'builtin-holo-spin');
    expect(holo?.disc?.style).toBe('holo');
  });

  it('every disc setting has a valid definition and default', () => {
    const d = defaultDiscSettings();
    expect(Object.keys(d)).toHaveLength(DISC_PARAMS.length);
    expect(d).toMatchObject({ enabled: true, overlay: false, style: 'classic', jewelCase: false, centerRing: true, hole: true, artMode: 'full', artFit: 'cover' });
    for (const p of DISC_PARAMS) expect(['disc', 'artwork']).toContain(p.group);
    expect(DISC_PARAMS.find((p) => p.key === 'style')?.options?.map((o) => o.value)).toEqual(['classic', 'dark', 'holo', 'matte', 'neon']);
  });

  it('sanitises stored / imported disc settings', () => {
    const s = sanitizeDisc({ style: 'laser', speed: 99, size: -4, tiltX: '30', jewelCase: 'yes', artOpacity: 0.5, hack: '<script>' });
    expect(s.style).toBe('classic');
    expect(s.speed).toBe(3);
    expect(s.size).toBe(0.3);
    expect(s.tiltX).toBe(30);
    expect(s.jewelCase).toBe(false);
    expect(s.artOpacity).toBe(0.5);
    expect('hack' in s).toBe(false);
    expect(sanitizeDisc(null)).toEqual(defaultDiscSettings());
  });
});

describe('disc settings in presets and links', () => {
  const disc = { ...defaultDiscSettings(), style: 'neon', jewelCase: true, overlay: true, artMode: 'print', artScale: 1.5 };

  it('round-trip through JSON with the preset', () => {
    const p = makePreset({ sceneId: 'cosmic-rings', values: {}, disc, name: 'NEON' });
    const back = presetsFromJson(presetToJson(p)).presets[0];
    expect(back.disc).toEqual(disc);
  });

  it('a share link carries only the changed disc values and restores them', () => {
    const p = makePreset({ sceneId: DISC_SCENE_ID, values: {}, disc });
    const res = decodePresetFromUrl(encodePresetForUrl(p));
    expect(res.ok && res.preset.disc).toEqual(disc);
  });

  it('a preset without disc settings keeps the current disc', () => {
    const res = migratePreset({ schema: 2, sceneId: 'plasma-flow', params: {} });
    expect(res.ok && res.preset.disc).toBeUndefined();
    useVisual.getState().setDiscParam('style', 'dark');
    useVisual.getState().loadPreset((res as { preset: Parameters<ReturnType<typeof useVisual.getState>['loadPreset']>[0] }).preset);
    expect(useVisual.getState().disc.style).toBe('dark');
    // one that has them replaces it
    useVisual.getState().loadPreset(makePreset({ sceneId: 'plasma-flow', values: {}, disc }));
    expect(useVisual.getState().disc).toEqual(disc);
  });

  it('a saved preset (snapshot) includes the disc, and settings survive storage sanitising', () => {
    useVisual.getState().setDiscParam('rim', 1.7);
    expect(useVisual.getState().snapshot('X').disc?.rim).toBe(1.7);
    useVisual.getState().setDiscParam('rim', 50);
    expect(useVisual.getState().disc.rim).toBe(2);
    useVisual.getState().setDiscParam('nope', 1);
    expect('nope' in useVisual.getState().disc).toBe(false);
  });
});

describe('enable / disable and TOGGLE DISC (C)', () => {
  it('SCENE 10 shows the disc; other scenes only with the overlay', () => {
    const d = defaultDiscSettings();
    expect(discVisible(DISC_SCENE_ID, d)).toBe(true);
    expect(discVisible('plasma-flow', d)).toBe(false);
    expect(discVisible('plasma-flow', { ...d, overlay: true })).toBe(true);
    expect(discVisible(DISC_SCENE_ID, { ...d, enabled: false })).toBe(false);
    expect(discVisible('plasma-flow', undefined)).toBe(false);
  });

  it('C hides and shows the disc on SCENE 10, and turns the overlay on elsewhere', () => {
    const d = defaultDiscSettings();
    const hidden = toggleDisc(DISC_SCENE_ID, d);
    expect(discVisible(DISC_SCENE_ID, hidden)).toBe(false);
    expect(discVisible(DISC_SCENE_ID, toggleDisc(DISC_SCENE_ID, hidden))).toBe(true);
    const over = toggleDisc('cosmic-rings', d);
    expect(over).toMatchObject({ enabled: true, overlay: true });
    const off = toggleDisc('cosmic-rings', over);
    expect(discVisible('cosmic-rings', off)).toBe(false);
    // only the disc changes — nothing else about the look
    const { enabled: _a, overlay: _b, ...rest } = off;
    const { enabled: _c, overlay: _d, ...before } = d;
    expect(rest).toEqual(before);
  });

  it('through the store: switching scenes and toggling keeps the rest of the visual', () => {
    useVisual.getState().resetDisc();
    useVisual.setState({ disc: defaultDiscSettings() });
    selectScene(DISC_SCENE_ID);
    expect(useVisual.getState().sceneId).toBe(DISC_SCENE_ID);
    const params = useVisual.getState().scenes[DISC_SCENE_ID].params;
    useVisual.getState().toggleDisc();
    expect(discVisible(DISC_SCENE_ID, useVisual.getState().disc)).toBe(false);
    expect(useVisual.getState().scenes[DISC_SCENE_ID].params).toBe(params);
    useVisual.getState().toggleDisc();
    expect(discVisible(DISC_SCENE_ID, useVisual.getState().disc)).toBe(true);
  });
});

describe('HIDE UI and the export state', () => {
  it('HIDE UI hides captions too by default; the CAPTIONS mode keeps them', () => {
    expect(appUiClasses(false, 'clean')).toBe('');
    expect(appUiClasses(true, 'clean')).toBe('ui-hidden ui-clean');
    expect(appUiClasses(true, 'captions')).toBe('ui-hidden');
  });

  it('hide / show UI changes nothing the renderer or an export receives', () => {
    useUi.getState().showUi();
    const before = visualSnapshot(useVisual.getState());
    useUi.getState().hideUi();
    const hidden = visualSnapshot(useVisual.getState());
    expect(hidden).toEqual(before);
    expect(Object.keys(hidden).sort()).toEqual(['disc', 'modulations', 'params', 'post', 'sceneId']);
    useUi.getState().escape(false);
    expect(useUi.getState().hidden).toBe(false);
    useUi.getState().toggleUi();
    expect(useUi.getState().hidden).toBe(true);
    useUi.getState().toggleUi();
    expect(useUi.getState().hidden).toBe(false);
  });
});

describe('composition per frame format', () => {
  const formats: [number, number][] = [
    [1920, 1080],
    [1280, 720],
    [3840, 2160],
    [1080, 1920],
    [720, 1280],
    [1080, 1080],
  ];

  for (const [w, h] of formats) {
    it(`${w}×${h}: the disc (and the case) fits the frame`, () => {
      for (const size of [0.3, 1, 1.6]) {
        for (const jewel of [false, true]) {
          const p = discPlacement(w, h, size, 0, 0, jewel);
          const ex = (jewel ? CASE_SIZE.width / 2 : 1) * p.radius;
          const ey = (jewel ? CASE_SIZE.height / 2 : 1) * p.radius;
          expect(p.x - ex).toBeGreaterThanOrEqual(0);
          expect(p.x + ex).toBeLessThanOrEqual(w);
          expect(p.y - ey).toBeGreaterThanOrEqual(0);
          expect(p.y + ey).toBeLessThanOrEqual(h);
        }
      }
    });
  }

  it('9:16 is laid out, not cropped: sized by the width, lifted above the middle', () => {
    const land = discPlacement(1920, 1080, 1, 0, 0, false);
    const port = discPlacement(1080, 1920, 1, 0, 0, false);
    expect(land.portrait).toBe(false);
    expect(port.portrait).toBe(true);
    expect(port.radius).toBeCloseTo(0.32 * 1080, 6);
    expect(port.y).toBeLessThan(1920 / 2);
    // a centre crop of the landscape layout would not fit the vertical frame
    expect(0.33 * 1920 * 2).toBeGreaterThan(1080);
    expect(port.radius * 2).toBeLessThan(1080);
    // the same picture at every resolution of a format
    const port4k = discPlacement(2160, 3840, 1, 0.3, -0.2, false);
    const port720 = discPlacement(720, 1280, 1, 0.3, -0.2, false);
    expect(port4k.radius / 2160).toBeCloseTo(port720.radius / 720, 9);
    expect(port4k.x / 2160).toBeCloseTo(port720.x / 720, 9);
  });

  it('artwork fit: cover fills the disc, contain shows all of it, center keeps its pixel size', () => {
    expect(artworkFit('cover', 2000, 1000)).toEqual({ sx: 0.5, sy: 1 });
    expect(artworkFit('contain', 2000, 1000)).toEqual({ sx: 1, sy: 2 });
    expect(artworkFit('cover', 1000, 1000)).toEqual({ sx: 1, sy: 1 });
    expect(artworkFit('center', 512, 256)).toEqual({ sx: 2, sy: 4 });
  });
});

describe('disc renderer: spin and audio reaction', () => {
  const settings = defaultDiscSettings();
  const base = (2 * Math.PI * 0.4) / 60; // one 60 fps frame at ROTATION SPEED 1

  it('spins continuously — never stops, never jumps, only eases a little faster with the music', () => {
    const layer = new DiscLayer(48);
    let prevSpin = 0;
    let prevStep = base;
    let maxChange = 0;
    let minStep = Infinity;
    let maxStep = 0;
    run(layer, settings, 60, 9, music, () => {
      const step = (layer.spin - prevSpin + 2 * Math.PI) % (2 * Math.PI);
      prevSpin = layer.spin;
      minStep = Math.min(minStep, step);
      maxStep = Math.max(maxStep, step);
      maxChange = Math.max(maxChange, Math.abs(step - prevStep));
      prevStep = step;
    });
    expect(minStep).toBeGreaterThanOrEqual(base * 0.999);
    expect(maxStep).toBeLessThanOrEqual(base * 1.36);
    expect(maxStep).toBeGreaterThan(base * 1.05); // the music does speed it up
    expect(maxChange).toBeLessThan(base * 0.01); // no frame-to-frame jerk, kicks included
    layer.dispose();
  });

  it('kick: a short rim flash with a soft attack; bass: a small scale pulse, never a wobble', () => {
    const layer = new DiscLayer(48);
    const restScale = (() => {
      layer.update(frame(settings));
      return placeScale(layer);
    })();
    const kicks: number[] = [];
    let maxScale = 0;
    let minScale = Infinity;
    const audio = createSceneAudio();
    const f = frame(settings, { audio });
    for (let i = 1; i <= 120; i++) {
      audio.bass = 1;
      audio.sub = 1;
      if (i === 30) {
        audio.kickCount = 1;
        audio.kickPeak = 1;
      }
      if (i === 2) audio.kickCount = 0;
      f.clock = i / 60;
      layer.update(f);
      kicks.push(uniforms(layer).uKick.value as number);
      maxScale = Math.max(maxScale, placeScale(layer));
      minScale = Math.min(minScale, placeScale(layer));
    }
    // the first frame of a kick is not already at full strength, it peaks within ~60 ms …
    expect(kicks[29]).toBeLessThan(0.6);
    const peak = Math.max(...kicks.slice(29, 40));
    expect(peak).toBeGreaterThan(0.5);
    // … and is gone after ~0.6 s
    expect(kicks[29 + 36]).toBeLessThan(0.1);
    expect(maxScale / restScale).toBeLessThanOrEqual(1.045);
    expect(minScale / restScale).toBeGreaterThanOrEqual(0.999);
    layer.dispose();
  });

  it('the spin does not depend on the frame rate (30 / 60 / 144 fps)', () => {
    const turns = [30, 60, 144].map((fps) => {
      const layer = new DiscLayer(48);
      let total = 0;
      let prev = 0;
      run(layer, settings, fps, 4, music, () => {
        total += (layer.spin - prev + 2 * Math.PI) % (2 * Math.PI);
        prev = layer.spin;
      });
      layer.dispose();
      return total;
    });
    expect(Math.abs(turns[0] - turns[2]) / turns[2]).toBeLessThan(0.01);
    expect(Math.abs(turns[1] - turns[2]) / turns[2]).toBeLessThan(0.005);
  });

  it('is deterministic: the same input gives the same disc (exports reproduce)', () => {
    const states = [0, 1].map(() => {
      const layer = new DiscLayer(48);
      run(layer, { ...settings, style: 'neon' }, 30, 3, music);
      const u = uniforms(layer);
      const out = [layer.spin, u.uKick.value, u.uMids.value, u.uTreble.value, u.uEnergy.value, placeScale(layer)];
      layer.dispose();
      return out;
    });
    expect(states[0]).toEqual(states[1]);
  });

  it('settings reach the shader: style, hole, ring, case, reflection', () => {
    const layer = new DiscLayer(48);
    layer.update(frame({ ...settings, style: 'holo', hole: false, centerRing: false, jewelCase: true, reflection: 1.4 }));
    const u = uniforms(layer);
    expect(u.uStyle.value).toBe(2);
    expect(u.uHole.value).toBe(0);
    expect(u.uRing.value).toBe(0);
    expect(u.uReflect.value).toBe(1.4);
    const caseGroup = (layer as unknown as { caseGroup: THREE.Group }).caseGroup;
    expect(caseGroup.visible).toBe(true);
    layer.update(frame({ ...settings, jewelCase: false }));
    expect(caseGroup.visible).toBe(false);
    layer.dispose();
  });
});

describe('disc renderer: artwork textures', () => {
  const art = (id: string, w = 800, h = 600): DiscArtwork => ({ id, source: { width: w, height: h } as unknown as HTMLCanvasElement, width: w, height: h });

  it('works without artwork (procedural disc)', () => {
    const layer = new DiscLayer(48);
    layer.update(frame(defaultDiscSettings()));
    expect(uniforms(layer).uHasArt.value).toBe(0);
    expect(layer.artworkTexture).toBeNull();
    layer.dispose();
  });

  it('upload → replace → remove: one texture at a time, the old one freed', () => {
    const layer = new DiscLayer(48);
    layer.setArtwork(art('a'));
    const first = layer.artworkTexture!;
    expect(uniforms(layer).uHasArt.value).toBe(1);
    expect(uniforms(layer).uArt.value).toBe(first);
    let freed = 0;
    first.addEventListener('dispose', () => freed++);
    layer.setArtwork(art('a')); // the same image: nothing changes
    expect(layer.artworkTexture).toBe(first);
    expect(freed).toBe(0);
    layer.setArtwork(art('b', 400, 400));
    const second = layer.artworkTexture!;
    expect(second).not.toBe(first);
    expect(freed).toBe(1);
    let freed2 = 0;
    second.addEventListener('dispose', () => freed2++);
    layer.setArtwork(null);
    expect(freed2).toBe(1);
    expect(uniforms(layer).uHasArt.value).toBe(0);
    expect(layer.artworkTexture).toBeNull();
    layer.dispose();
  });

  it('artwork settings set the transform and colour adjustments', () => {
    const layer = new DiscLayer(48);
    layer.setArtwork(art('wide', 2000, 1000));
    layer.update(frame({ ...defaultDiscSettings(), artFit: 'cover', artScale: 2, artOffsetX: 0.25, artOffsetY: -0.5, artRotation: 90, artBrightness: 1.2, artContrast: 0.8, artSaturation: 0, artOpacity: 0.5, artMode: 'label' }));
    const u = uniforms(layer);
    const xf = u.uArtXf.value as THREE.Vector4;
    expect([xf.x, xf.y, xf.z, xf.w]).toEqual([0.25, 0.5, 0.25, -0.5]);
    expect(u.uArtRot.value).toBeCloseTo(Math.PI / 2, 9);
    const adj = u.uArtAdj.value as THREE.Vector4;
    expect([adj.x, adj.y, adj.z, adj.w]).toEqual([1.2, 0.8, 0, 0.5]);
    expect(u.uArtMode.value).toBe(1);
    layer.dispose();
  });

  it('dispose frees every geometry, material and texture', () => {
    const layer = new DiscLayer(48);
    layer.setArtwork(art('x'));
    const tex = layer.artworkTexture!;
    let disposed = 0;
    tex.addEventListener('dispose', () => disposed++);
    const parts = new Set<{ addEventListener: THREE.EventDispatcher['addEventListener'] }>();
    layer.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) parts.add(m.geometry as never);
      if (m.material) parts.add(m.material as never);
    });
    for (const p of parts) (p as unknown as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', () => disposed++);
    layer.dispose();
    expect(disposed).toBe(parts.size + 1);
    expect(layer.artworkTexture).toBeNull();
  });
});
