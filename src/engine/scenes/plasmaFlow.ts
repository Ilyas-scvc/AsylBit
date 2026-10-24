/**
 * SCENE 08 — PLASMA FLOW
 *
 * A full-screen procedural shader: three levels of domain-warped fractal noise produce
 * slow liquid forms; thin "light trails" are the iso-lines of the warped field, so they
 * flow along the liquid instead of being painted on top of it.
 *
 *   bass   → warp strength (large liquid motion) + core brightness
 *   mids   → detail warp and colour mix
 *   treble → trail brightness and fine sparkle
 *   kick   → a bounded brightness swell (no strobing)
 *
 * Coordinates are normalized by the shorter screen side, so 9:16 and 16:9 frames show the
 * same composition centred instead of a stretched or cropped one.
 */
import * as THREE from 'three';
import { Spring } from '../../audio/dsp/envelope';
import { GLSL_GRADIENT } from '../colors';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { FULLSCREEN_VERT, directionSign, disposeTree, fullscreenMesh, wrapDegrees } from './common';

const FRAG = /* glsl */ `
uniform vec2 uRes;
uniform float uFlow;
uniform float uScale;
uniform float uOctaves;
uniform float uWarp;
uniform float uBass;
uniform float uMids;
uniform float uTreble;
uniform float uSwell;
uniform float uTrails;
uniform float uTrailDensity;
uniform float uAngle;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform vec3 uBackground;
uniform float uGradient;
varying vec2 vUv;
${GLSL_GRADIENT}

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 7; i++) {
    if (float(i) >= uOctaves) break;
    s += a * vnoise(p);
    p = r * p * 2.03 + 11.7;
    a *= 0.5;
  }
  return s;
}
void main() {
  vec2 uv = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
  float c = cos(uAngle), s = sin(uAngle);
  uv = mat2(c, -s, s, c) * uv * (2.2 / uScale);
  float t = uFlow;
  float warp = uWarp * (0.7 + uBass * 0.9);
  vec2 q = vec2(fbm(uv + vec2(0.0, t * 0.11)), fbm(uv + vec2(5.2, 1.3) - t * 0.09));
  vec2 r = vec2(fbm(uv + warp * 3.2 * q + vec2(1.7, 9.2) + t * 0.13), fbm(uv + warp * 3.2 * q + vec2(8.3, 2.8) - t * 0.10));
  float f = fbm(uv + warp * (2.6 + uMids * 1.4) * r);

  // colour: background → secondary → primary along the field, shifted by the spectrum
  float k = clamp(f * f * 1.6 + length(q) * 0.35, 0.0, 1.0);
  vec3 tone = bfGradient(uGradient, clamp(length(r) * 0.8 + uMids * 0.15, 0.0, 1.0), k, uPrimary, uSecondary);
  vec3 col = mix(uBackground, tone, smoothstep(0.08, 0.95, k));
  col *= 0.55 + 0.65 * uBass + 0.25 * uSwell;

  // light trails: thin iso-lines of the warped field, flowing with it
  float iso = f * (6.0 + uTrailDensity * 22.0) + t * 0.35;
  float w = max(fwidth(iso), 1e-3);
  float line = 1.0 - smoothstep(0.0, 1.6, abs(fract(iso) - 0.5) / w);
  float glow = exp(-abs(fract(iso) - 0.5) * 9.0) * 0.25;
  vec3 trailCol = mix(uPrimary, vec3(1.0), 0.25);
  col += trailCol * (line * 0.55 + glow) * uTrails * (0.25 + uTreble * 1.1) * smoothstep(0.15, 0.7, k);

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

class PlasmaFlowScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly mat: THREE.ShaderMaterial;
  private flow = 0;
  private angle = 0;
  private readonly swell = new Spring(0, 90, 16);
  private kickSeen = -1;
  private kickHold = 0;
  private readonly maxOctaves: number;

  constructor(env: SceneEnv) {
    this.maxOctaves = env.quality.detail === 'high' ? 6 : 4;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: FRAG,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) },
        uFlow: { value: 0 },
        uScale: { value: 1 },
        uOctaves: { value: 4 },
        uWarp: { value: 1 },
        uBass: { value: 0 },
        uMids: { value: 0 },
        uTreble: { value: 0 },
        uSwell: { value: 0 },
        uTrails: { value: 1 },
        uTrailDensity: { value: 0.5 },
        uAngle: { value: 0 },
        uPrimary: { value: new THREE.Color() },
        uSecondary: { value: new THREE.Color() },
        uBackground: { value: new THREE.Color() },
        uGradient: { value: 1 },
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

    if (a.kickCount !== this.kickSeen) {
      const first = this.kickSeen < 0;
      this.kickSeen = a.kickCount;
      if (!first) this.kickHold = Math.min(1, a.kick + 0.2);
    }
    this.kickHold = Math.max(0, this.kickHold - dt * 3);
    const swell = this.swell.step(this.kickHold * 0.6 * motion, dt);

    this.flow += dt * p.num('speed') * (0.35 + 0.5 * a.mids * intensity) * motion * dir;
    this.angle += dt * 0.04 * p.num('rotation') * motion * dir;
    const rot = this.angle + ((p.num('cameraRotation') + p.num('autoOrbit') * ctx.clock) * Math.PI) / 180;

    const u = this.mat.uniforms;
    (u.uRes.value as THREE.Vector2).set(ctx.width, ctx.height);
    u.uFlow.value = this.flow;
    u.uScale.value = p.num('scale') * p.num('zoom');
    u.uOctaves.value = Math.max(2, Math.min(this.maxOctaves, 2 + Math.round(p.num('complexity') * 4)));
    u.uWarp.value = p.num('deformation');
    u.uBass.value = Math.min(1.3, (a.bass * 0.7 + a.sub * 0.3) * intensity * motion);
    u.uMids.value = Math.min(1.3, a.mids * intensity);
    u.uTreble.value = Math.min(1.3, a.treble * intensity);
    u.uSwell.value = swell;
    u.uTrails.value = p.num('trails');
    u.uTrailDensity.value = p.num('trailDensity');
    u.uAngle.value = rot;
    (u.uPrimary.value as THREE.Color).copy(ctx.palette.primary);
    (u.uSecondary.value as THREE.Color).copy(ctx.palette.secondary);
    (u.uBackground.value as THREE.Color).copy(ctx.palette.background);
    u.uGradient.value = ctx.palette.gradient;
    this.telemetry.rotation = wrapDegrees((rot * 180) / Math.PI);
  }

  dispose(): void {
    disposeTree(this.root);
  }
}

export const create: SceneFactory = (env) => new PlasmaFlowScene(env);
