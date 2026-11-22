/**
 * SCENE 10 — SPINNING DISC
 *
 * The studio around the disc: a dark backdrop with a soft spotlight, a haze behind the disc
 * that breathes with the bass, and slow dust that glints with the treble. The disc itself is
 * drawn by the engine's DiscLayer (the same renderer that can show it over every other scene),
 * from the global DISC settings.
 *
 *   bass   → haze breathing
 *   kick   → a bounded haze swell
 *   treble → dust glints
 *
 * Like the disc's placement, the backdrop follows the frame format: on vertical frames the
 * haze centre moves up with the disc.
 */
import * as THREE from 'three';
import { Spring } from '../../audio/dsp/envelope';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { disposeTree, FULLSCREEN_VERT, fullscreenMesh, rng } from './common';

const BACK_FRAG = /* glsl */ `
uniform vec2 uRes;
uniform vec3 uBackground;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform float uHaze;
uniform float uBass;
uniform float uSwell;
uniform float uFalloff;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
  float portrait = step(uRes.x, uRes.y * 0.85);
  vec2 c = vec2(0.0, portrait * 0.1 * uRes.y / min(uRes.x, uRes.y));
  float d = length(p - c);
  vec3 col = uBackground;
  float spot = exp(-pow(length((p - c - vec2(-0.25, 0.75)) * vec2(1.0, 0.55)), 2.0) * 1.4);
  col += mix(uSecondary, vec3(1.0), 0.6) * spot * 0.06 * uHaze;
  col += uPrimary * exp(-d * d * 2.4) * (0.05 + 0.07 * uBass + 0.06 * uSwell) * uHaze;
  col += uSecondary * smoothstep(0.1, -0.9, p.y - c.y) * 0.025 * uHaze;
  col *= 1.0 - uFalloff * 0.85 * smoothstep(0.45, 1.35, d);
  // dither against banding in the dark gradient
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

const DUST_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uClock;
uniform float uDrift;
uniform float uTreble;
uniform float uSize;
varying float vA;
void main() {
  vec2 pos = aSeed.xy;
  pos.y = fract(pos.y + uDrift * (0.004 + aSeed.z * 0.012));
  pos.x = fract(pos.x + sin(uClock * 0.1 + aSeed.w * 6.2831) * 0.01);
  float tw = 0.5 + 0.5 * sin(uClock * (1.5 + aSeed.z * 4.0) + aSeed.w * 30.0);
  vA = (0.12 + 0.88 * uTreble * tw) * (0.4 + 0.6 * aSeed.z);
  gl_PointSize = uSize * (0.6 + aSeed.z * 1.4);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  gl_FragColor = vec4(uColor * smoothstep(0.5, 0.0, d) * vA * uAmount, 1.0);
}
`;

class SpinningDiscScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly back: THREE.ShaderMaterial;
  private readonly dust: THREE.ShaderMaterial;
  private readonly swell = new Spring(0, 90, 16);
  private kickSeen = -1;
  private kickHold = 0;
  private drift = 0;
  private treble = 0;

  constructor(env: SceneEnv) {
    this.back = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BACK_FRAG,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) },
        uBackground: { value: new THREE.Color() },
        uPrimary: { value: new THREE.Color() },
        uSecondary: { value: new THREE.Color() },
        uHaze: { value: 0.6 },
        uBass: { value: 0 },
        uSwell: { value: 0 },
        uFalloff: { value: 0.7 },
      },
    });
    this.root.add(fullscreenMesh(this.back));

    const count = Math.round(260 * env.quality.particles);
    const seeds = new Float32Array(count * 4);
    const rand = rng(1010);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    // positions are computed in the vertex shader; three only needs the vertex count
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    this.dust = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: {
        uClock: { value: 0 },
        uDrift: { value: 0 },
        uTreble: { value: 0 },
        uSize: { value: 3 },
        uColor: { value: new THREE.Color() },
        uAmount: { value: 0.5 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, this.dust);
    points.frustumCulled = false;
    points.renderOrder = -5;
    this.root.add(points);
  }

  update(ctx: SceneFrameContext): void {
    const p = ctx.params;
    const a = ctx.audio;
    const dt = ctx.dt;
    const motion = ctx.reducedMotion ? 0.4 : 1;
    const intensity = p.num('motionIntensity');

    if (a.kickCount !== this.kickSeen) {
      const first = this.kickSeen < 0;
      this.kickSeen = a.kickCount;
      if (!first) this.kickHold = Math.min(1, a.kickPeak + 0.1);
    }
    this.kickHold = Math.max(0, this.kickHold - dt * 3);
    const swell = this.swell.step(this.kickHold * 0.6 * motion, dt);
    this.drift += dt * p.num('speed') * motion;
    this.treble += (Math.min(1, a.treble * intensity) - this.treble) * Math.min(1, dt * 8);

    const u = this.back.uniforms;
    (u.uRes.value as THREE.Vector2).set(ctx.width, ctx.height);
    (u.uBackground.value as THREE.Color).copy(ctx.palette.background);
    (u.uPrimary.value as THREE.Color).copy(ctx.palette.primary);
    (u.uSecondary.value as THREE.Color).copy(ctx.palette.secondary);
    u.uHaze.value = p.num('haze');
    u.uBass.value = Math.min(1.2, (a.bass * 0.7 + a.sub * 0.3) * intensity * motion);
    u.uSwell.value = swell;
    u.uFalloff.value = p.num('falloff');

    const d = this.dust.uniforms;
    d.uClock.value = ctx.clock;
    d.uDrift.value = this.drift;
    d.uTreble.value = this.treble;
    d.uSize.value = Math.max(1.5, (Math.min(ctx.width, ctx.height) / 1080) * 4 * ctx.pixelRatio);
    (d.uColor.value as THREE.Color).copy(ctx.palette.primary).lerp(WHITE, 0.55);
    d.uAmount.value = p.num('dust');
  }

  dispose(): void {
    disposeTree(this.root);
  }
}

const WHITE = new THREE.Color(1, 1, 1);

export const create: SceneFactory = (env) => new SpinningDiscScene(env);
