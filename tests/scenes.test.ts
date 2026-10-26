/**
 * Scene behaviour that does not need a GPU: geometry lifetime and camera maths. Scenes are
 * created with a stub renderer (no scene touches it) and updated with a hand-built frame
 * context; three.js objects are real.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createSceneAudio } from '../src/engine/features';
import { defaultParams, getSceneSchema, ValuesReader } from '../src/engine/params';
import { qualityProfile } from '../src/engine/quality';
import { SCENE_FACTORIES } from '../src/engine/scenes/factories';
import { getScene, sceneRegistry } from '../src/engine/scenes/registry';
import type { ParamValues, PerformancePreset, SceneFrameContext, SceneInstance } from '../src/engine/types';
import { SceneController } from '../src/engine/VisualizerEngine';

const renderer = {} as THREE.WebGLRenderer;

function makeContext(sceneId: string, params: ParamValues, preset: PerformancePreset, camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.05, 200)) {
  const reader = new ValuesReader();
  reader.values = { ...defaultParams(getSceneSchema(getScene(sceneId))), ...params };
  const audio = createSceneAudio();
  audio.bass = 0.5;
  audio.spectrum.fill(0.4);
  const ctx: SceneFrameContext = {
    time: 0,
    clock: 0,
    dt: 1 / 60,
    audio,
    params: reader,
    palette: { primary: new THREE.Color(1, 1, 0), secondary: new THREE.Color(0, 1, 1), background: new THREE.Color(0, 0, 0), gradient: 1 },
    camera,
    width: 1920,
    height: 1080,
    aspect: 16 / 9,
    pixelRatio: 1,
    quality: qualityProfile(preset),
    reducedMotion: false,
    pointer: { x: 0, y: 0 },
    exporting: true,
  };
  return { ctx, reader, camera };
}

function step(instance: SceneInstance, ctx: SceneFrameContext, frames = 1) {
  for (let i = 0; i < frames; i++) {
    ctx.time += ctx.dt;
    ctx.clock += ctx.dt;
    instance.update(ctx);
  }
}

describe('REACTIVE MESH geometry lifetime', () => {
  for (const preset of ['eco', 'balanced', 'quality', 'ultra'] as PerformancePreset[]) {
    it(`keeps one grid geometry while settings are unchanged (${preset}, max resolution)`, () => {
      const instance = SCENE_FACTORIES['reactive-mesh']({ quality: qualityProfile(preset), renderer });
      const { ctx } = makeContext('reactive-mesh', { density: 0.9 }, preset);
      const mesh = instance as unknown as { lines: THREE.LineSegments; dots: THREE.Points };
      step(instance, ctx);
      const geometry = mesh.lines.geometry;
      const dots = mesh.dots.geometry;
      step(instance, ctx, 5);
      expect(mesh.lines.geometry).toBe(geometry);
      expect(mesh.dots.geometry).toBe(dots);
      instance.dispose();
    });
  }

  it('rebuilds exactly once on a real change and disposes the old buffers', () => {
    const instance = SCENE_FACTORIES['reactive-mesh']({ quality: qualityProfile('quality'), renderer });
    const { ctx, reader } = makeContext('reactive-mesh', { density: 0.9 }, 'quality');
    const mesh = instance as unknown as { lines: THREE.LineSegments; dots: THREE.Points };
    step(instance, ctx);
    const before = mesh.lines.geometry;
    let disposed = 0;
    before.addEventListener('dispose', () => disposed++);
    reader.values = { ...reader.values, density: 0.4 };
    step(instance, ctx, 4);
    expect(mesh.lines.geometry).not.toBe(before);
    expect(disposed).toBe(1);
    const after = mesh.lines.geometry;
    step(instance, ctx, 4);
    expect(mesh.lines.geometry).toBe(after);
    instance.dispose();
  });
});

describe('AUDIO TUNNEL camera', () => {
  const tunnelFov = (fov: number, zoom: number) => {
    const instance = SCENE_FACTORIES['audio-tunnel']({ quality: qualityProfile('balanced'), renderer });
    const { ctx, camera } = makeContext('audio-tunnel', { fov, zoom }, 'balanced');
    step(instance, ctx);
    instance.dispose();
    return camera;
  };

  it('narrows / widens the view like a lens zoom and never reaches 180°', () => {
    const fovDef = getSceneSchema(getScene('audio-tunnel')).find((d) => d.key === 'fov')!;
    const zoomDef = getSceneSchema(getScene('audio-tunnel')).find((d) => d.key === 'zoom')!;
    for (const fov of [fovDef.min!, 72, 90, fovDef.max!]) {
      for (const zoom of [zoomDef.min!, 1, zoomDef.max!]) {
        const cam = tunnelFov(fov, zoom);
        const expected = (2 * Math.atan(Math.tan((fov * Math.PI) / 360) / zoom) * 180) / Math.PI;
        expect(cam.fov).toBeCloseTo(expected, 6);
        expect(cam.fov).toBeGreaterThan(0);
        expect(cam.fov).toBeLessThan(170);
        // a valid, non-inverted perspective projection
        const m = cam.projectionMatrix.elements;
        expect(Number.isFinite(m[0]) && Number.isFinite(m[5])).toBe(true);
        expect(m[5]).toBeGreaterThan(0);
        expect(cam.zoom).toBe(1);
      }
    }
    // 72° at ZOOM 0.4 and 90° at ZOOM 0.4 were the reported broken cases
    expect(tunnelFov(72, 0.4).fov).toBeLessThan(130);
    expect(tunnelFov(90, 0.4).fov).toBeLessThan(140);
  });

  it('a stronger zoom always gives a narrower view', () => {
    let previous = 180;
    for (const zoom of [0.4, 0.6, 1, 1.5, 2, 3]) {
      const fov = tunnelFov(72, zoom).fov;
      expect(fov).toBeLessThan(previous);
      previous = fov;
    }
  });
});

describe('shared camera across scene switches', () => {
  it('a scene never inherits the previous scene’s camera roll, zoom or clipping', () => {
    const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.05, 200);
    const scene = new THREE.Scene();
    const controller = new SceneController(scene, renderer, camera);
    for (const def of sceneRegistry.list()) {
      // the tunnel at its most extreme settings, then the next scene
      controller.setScene('audio-tunnel', qualityProfile('balanced'));
      const t = makeContext('audio-tunnel', { fov: 110, zoom: 0.4, cameraRotation: 90 }, 'balanced', camera);
      step(controller.instance!, t.ctx);
      if (def.id === 'audio-tunnel') continue;
      controller.setScene(def.id, qualityProfile('balanced'));
      expect(camera.up.toArray()).toEqual([0, 1, 0]);
      expect(camera.zoom).toBe(1);
      const c = makeContext(def.id, {}, 'balanced', camera);
      step(controller.instance!, c.ctx);
      const m = camera.projectionMatrix.elements;
      expect(m[5]).toBeGreaterThan(0);
      expect(camera.fov).toBeLessThan(170);
    }
    controller.dispose();
  });
});

describe('no scene rebuilds its geometry while nothing changes', () => {
  const geometries = (root: THREE.Object3D) => {
    const ids: string[] = [];
    root.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g) ids.push(g.uuid);
    });
    return ids.sort().join(',');
  };
  for (const def of sceneRegistry.list()) {
    it(`${def.name} at ULTRA with every density / resolution control at its maximum`, () => {
      const instance = SCENE_FACTORIES[def.id]({ quality: qualityProfile('ultra'), renderer });
      const maxed: ParamValues = {};
      for (const d of getSceneSchema(def)) if (d.type === 'number' && ['density', 'complexity', 'rings', 'lineDensity'].includes(d.key)) maxed[d.key] = d.max!;
      const { ctx } = makeContext(def.id, maxed, 'ultra');
      step(instance, ctx, 2);
      const first = geometries(instance.root);
      step(instance, ctx, 4);
      expect(geometries(instance.root)).toBe(first);
      instance.dispose();
    });
  }
});

describe('REACTIVE MESH kicks', () => {
  type Mesh = SceneInstance & { waves: { count: number; levels(): number[] }; phase: number; spin: number; head: number; lines: THREE.LineSegments; lineMat: THREE.ShaderMaterial };
  /** Play `seconds` at `fps`; kicks (s) bump kickCount with the given peak. */
  function play(layout: string, kicks: number[], opts: { seconds?: number; fps?: number; peak?: number; speed?: number } = {}) {
    const fps = opts.fps ?? 60;
    const instance = SCENE_FACTORIES['reactive-mesh']({ quality: qualityProfile('balanced'), renderer }) as Mesh;
    const { ctx } = makeContext('reactive-mesh', { layout, speed: opts.speed ?? 1 }, 'balanced');
    ctx.dt = 1 / fps;
    const pending = [...kicks];
    const frames = Math.round((opts.seconds ?? 2) * fps);
    for (let n = 1; n <= frames; n++) {
      const t = n / fps;
      while (pending.length && pending[0] <= t + 1e-9) {
        pending.shift();
        ctx.audio.kickCount++;
        ctx.audio.kickPeak = opts.peak ?? 1;
      }
      ctx.time = t;
      ctx.clock = t;
      instance.update(ctx);
    }
    return instance;
  }

  for (const layout of ['flat', 'spiral', 'bowl']) {
    it(`${layout.toUpperCase()}: a new kick adds a ring and the previous one keeps going`, () => {
      const m = play(layout, [0.5, 1.0], { seconds: 1.05 });
      expect(m.waves.count).toBe(2);
      const u = m.lineMat.uniforms;
      expect(u.uWaveCount.value).toBe(2);
      const data = u.uWaves.value as Float32Array;
      expect(data[0]).toBeGreaterThan(data[2]); // the older ring is further out
      expect(data[1]).toBeGreaterThan(0.1); // and still clearly visible
      m.dispose();
    });
  }

  it('kicks never reset the phase, rotation, spectrum history or geometry', () => {
    const quiet = play('flat', [], { seconds: 3 });
    const kicked = play('flat', [0.5, 1, 1.5, 2, 2.5], { seconds: 3 });
    expect(kicked.phase).toBe(quiet.phase);
    expect(kicked.spin).toBe(quiet.spin);
    expect(kicked.head).toBe(quiet.head);
    expect(kicked.lines.geometry.attributes.position.count).toBe(quiet.lines.geometry.attributes.position.count);
    quiet.dispose();
    kicked.dispose();
  });

  it('KICK IMPACT 0 (a 0 peak) adds no ring at all', () => {
    const m = play('flat', [0.5, 1.0, 1.5], { peak: 0 });
    expect(m.waves.count).toBe(0);
    expect(m.lineMat.uniforms.uWaveCount.value).toBe(0);
    m.dispose();
  });

  it('a held bass without kicks (like 12–14 s of the test pattern) spawns nothing', () => {
    const m = play('flat', [], { seconds: 2 });
    expect(m.waves.count).toBe(0);
    m.dispose();
  });

  it('minimum SPEED with kicks every 0.5 s stays well inside the pool', () => {
    const m = play('spiral', Array.from({ length: 16 }, (_, i) => 0.5 + i * 0.5), { seconds: 9, speed: 0 });
    expect(m.waves.count).toBeLessThanOrEqual(8);
    m.dispose();
  });

  it('the same kicks give the same rings at 30, 60 and 144 fps', () => {
    const at = (fps: number) => {
      const m = play('bowl', [0.5, 1.0, 1.5], { seconds: 2, fps });
      const out = Array.from(m.lineMat.uniforms.uWaves.value as Float32Array).slice(0, m.waves.count * 2);
      m.dispose();
      return out;
    };
    const a = at(30);
    const b = at(60);
    const c = at(144);
    expect(a.length).toBe(b.length);
    expect(a.length).toBe(c.length);
    a.forEach((v, i) => {
      expect(b[i]).toBeCloseTo(v, 5);
      expect(c[i]).toBeCloseTo(v, 5);
    });
  });
});
