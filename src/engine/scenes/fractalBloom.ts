/**
 * SCENE 09 — FRACTAL BLOOM
 *
 * A symmetric generative composition: the plane is folded into `symmetry` mirrored
 * segments, then iterated a few times (abs-fold → rotate → scale, an IFS-like "kaleidoscopic
 * fractal" capped at 8 iterations, so it stays cheap). Every iteration draws glowing rings
 * and petals whose sizes listen to their own band group — low bands drive the outer
 * structure, high bands the fine inner detail.
 *
 * Anti-flicker: band inputs come from the smoothed spectrum, layer rotations integrate on
 * the CPU, line widths are derived from screen-space derivatives (fwidth), and the kick
 * only drives a damped spring swell.
 */
import * as THREE from 'three';
import { DISPLAY_BANDS } from '../../audio/analysis/frame';
import { Spring } from '../../audio/dsp/envelope';
import { GLSL_GRADIENT } from '../colors';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { FULLSCREEN_VERT, directionSign, disposeTree, fullscreenMesh, wrapDegrees } from './common';

const MAX_ITER = 8;

const FRAG = /* glsl */ `
uniform vec2 uRes;
uniform float uSym;
uniform float uIter;
uniform float uScale;
uniform float uBaseRot;
uniform float uLayerRot[${MAX_ITER}];
uniform float uBand[${MAX_ITER}];
uniform float uFold;
uniform float uDeform;
uniform float uPetals;
uniform float uGlow;
uniform float uSwell;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform vec3 uBackground;
uniform float uGradient;
varying vec2 vUv;
${GLSL_GRADIENT}

vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

void main() {
  vec2 p0 = (vUv - 0.5) * uRes / min(uRes.x, uRes.y) * 2.0;
  vec2 p = p0 / (uScale * (1.0 + uSwell * 0.06));
  float r0 = length(p);
  float px = max(fwidth(r0), 1e-4);
  // polar symmetry fold
  float seg = 6.28318530718 / uSym;
  float a = mod(atan(p.y, p.x) + uBaseRot, seg);
  a = abs(a - seg * 0.5);
  p = vec2(cos(a), sin(a)) * r0;

  vec3 col = vec3(0.0);
  float scale = 1.0;
  for (int i = 0; i < ${MAX_ITER}; i++) {
    if (float(i) >= uIter) break;
    float band = uBand[i];
    p = abs(p) - vec2(0.38 + band * 0.14 * uDeform, 0.12 + uFold);
    p = rot(p, uLayerRot[i] + 0.35);
    p *= 1.34;
    scale *= 1.34;
    float t = float(i) / max(1.0, uIter - 1.0);
    // ring outline (in screen units) and petal spine
    float ring = abs(length(p) - (0.5 + band * 0.32)) / scale;
    float spine = abs(p.y) / scale;
    float core = exp(-ring / (px * 1.1 + 0.0015));
    float halo = exp(-ring * 22.0) * 0.3 * uGlow;
    float petal = exp(-spine / (px * 1.0 + 0.0012)) * (1.0 - smoothstep(0.0, 1.2, abs(p.x))) * 0.35 * uPetals;
    vec3 c = bfGradient(uGradient, t, clamp(band * 1.2, 0.0, 1.0), uPrimary, uSecondary);
    col += c * (core * 0.8 + halo + petal) * (0.3 + band * 1.1) * pow(0.86, float(i));
  }
  col *= 1.0 + uSwell * 0.3;
  col *= 1.0 - smoothstep(1.2, 2.1, r0 * uScale);
  col += uBackground;
  gl_FragColor = vec4(col, 1.0);
}
`;

class FractalBloomScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly mat: THREE.ShaderMaterial;
  private readonly layerRot = new Float32Array(MAX_ITER);
  private readonly bands = new Float32Array(MAX_ITER);
  private baseRot = 0;
  private readonly swell = new Spring(0, 120, 18);
  private kickSeen = -1;
  private kickHold = 0;
  private readonly maxIter: number;

  constructor(env: SceneEnv) {
    this.maxIter = env.quality.detail === 'high' ? MAX_ITER : 6;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) },
        uSym: { value: 8 },
        uIter: { value: 5 },
        uScale: { value: 1 },
        uBaseRot: { value: 0 },
        uLayerRot: { value: this.layerRot },
        uBand: { value: this.bands },
        uFold: { value: 0.1 },
        uDeform: { value: 1 },
        uPetals: { value: 0.6 },
        uGlow: { value: 1 },
        uSwell: { value: 0 },
        uPrimary: { value: new THREE.Color() },
        uSecondary: { value: new THREE.Color() },
        uBackground: { value: new THREE.Color() },
        uGradient: { value: 3 },
      },
    });
    this.root.add(fullscreenMesh(this.mat));
  }

  update(ctx: SceneFrameContext): void {
    const p = ctx.params;
    const a = ctx.audio;
    const dt = ctx.dt;
    const motion = ctx.reducedMotion ? 0.4 : 1;
    const intensity = p.num('motionIntensity');
    const dir = directionSign(p.str('direction'));
    const iter = Math.max(2, Math.min(this.maxIter, 2 + Math.round(p.num('complexity') * 6)));

    // band group per iteration: outer layers ← lows, inner layers ← highs
    for (let i = 0; i < MAX_ITER; i++) {
      const b0 = Math.floor((i / MAX_ITER) * (DISPLAY_BANDS - 8));
      let s = 0;
      for (let b = b0; b < b0 + 8; b++) s += a.spectrum[b];
      const target = Math.min(1.2, (s / 8) * intensity);
      // gentle extra smoothing keeps the geometry from shimmering on noisy highs
      this.bands[i] += (target - this.bands[i]) * Math.min(1, dt * 14);
      const alt = i % 2 === 0 ? 1 : -1;
      this.layerRot[i] += dt * p.num('rotation') * motion * dir * alt * (0.05 + 0.025 * i) * (1 + this.bands[i] * 0.6);
    }
    this.baseRot += dt * 0.03 * p.num('speed') * motion * dir;

    if (a.kickCount !== this.kickSeen) {
      const first = this.kickSeen < 0;
      this.kickSeen = a.kickCount;
      if (!first) this.kickHold = Math.min(1, a.kick + 0.2);
    }
    this.kickHold = Math.max(0, this.kickHold - dt * 3);
    const swell = this.swell.step(this.kickHold * 0.7 * motion, dt);

    const u = this.mat.uniforms;
    (u.uRes.value as THREE.Vector2).set(ctx.width, ctx.height);
    u.uSym.value = Math.max(2, Math.round(p.num('symmetry')));
    u.uIter.value = iter;
    u.uScale.value = p.num('scale') * p.num('zoom');
    u.uBaseRot.value = this.baseRot + ((p.num('cameraRotation') + p.num('autoOrbit') * ctx.clock) * Math.PI) / 180;
    u.uFold.value = p.num('fold');
    u.uDeform.value = p.num('deformation');
    u.uPetals.value = p.num('petals');
    u.uGlow.value = p.num('glow');
    u.uSwell.value = swell;
    (u.uPrimary.value as THREE.Color).copy(ctx.palette.primary);
    (u.uSecondary.value as THREE.Color).copy(ctx.palette.secondary);
    (u.uBackground.value as THREE.Color).copy(ctx.palette.background);
    u.uGradient.value = ctx.palette.gradient;
    this.telemetry.rotation = wrapDegrees((this.baseRot * 180) / Math.PI);
  }

  dispose(): void {
    disposeTree(this.root);
  }
}

export const create: SceneFactory = (env) => new FractalBloomScene(env);
