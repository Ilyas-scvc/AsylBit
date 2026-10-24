/**
 * SCENE 06 — PARTICLE CLOUD
 *
 * Tens of thousands of GPU particles in one draw call. Every particle position is an
 * analytic function of its seed and the clock, computed in the vertex shader — there is no
 * CPU simulation, so frames are cheap and exports are reproducible.
 *
 *   shape  → smooth morph CLOUD (0) → SPIRAL galaxy (1) → SPHERE (2)
 *   vortex → differential rotation (inner particles orbit faster)
 *   each particle belongs to one frequency band and is pushed outward, enlarged and
 *   brightened by that band only · kick → global breathing pulse · mids → turbulence
 */
import * as THREE from 'three';
import { DISPLAY_BANDS } from '../../audio/analysis/frame';
import { Spring } from '../../audio/dsp/envelope';
import { applyCamera } from '../camera';
import { GLSL_GRADIENT } from '../colors';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { SIMPLEX_NOISE_3D, directionSign, disposeTree, rng, wrapDegrees } from './common';

const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform sampler2D uSpectrum;
uniform float uMorph;
uniform float uArms;
uniform float uTwist;
uniform float uRadius;
uniform float uClock;
uniform float uVortex;
uniform float uTurbulence;
uniform float uMids;
uniform float uReact;
uniform float uPulse;
uniform float uSize;
uniform float uPointScale;
uniform float uIdle;
varying float vLevel;
varying float vBand;
varying float vSeed;
varying float vCover;
${SIMPLEX_NOISE_3D}

vec3 sphereDir(float u, float v) {
  float z = u * 2.0 - 1.0;
  float a = v * 6.28318530718;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(cos(a) * r, z, sin(a) * r);
}

void main() {
  float s1 = aSeed.x;
  float s2 = aSeed.y;
  float s3 = aSeed.z;
  float s4 = aSeed.w;
  float band = floor(s4 * ${DISPLAY_BANDS}.0) / ${DISPLAY_BANDS - 1}.0;
  float level = texture2D(uSpectrum, vec2(band, 0.5)).r * 1.3;

  // CLOUD: soft, slightly lumpy ball
  vec3 dir = sphereDir(s2, s3);
  float rc = pow(s1, 0.55) * uRadius;
  vec3 cloud = dir * rc * (0.85 + 0.3 * snoise(dir * 1.7 + 3.1));
  // SPIRAL: galaxy arms in the XZ plane
  float arm = floor(s4 * uArms);
  float rs = pow(s1, 0.75) * uRadius * 1.15;
  float as = arm / uArms * 6.28318530718 + rs * uTwist + (s2 - 0.5) * 0.55 * (1.2 - s1);
  vec3 spiral = vec3(cos(as) * rs, (s3 - 0.5) * 0.18 * uRadius * (1.0 - s1 * 0.7), sin(as) * rs);
  // SPHERE: thin shell
  vec3 sphere = dir * uRadius * (0.92 + (s1 - 0.5) * 0.05);

  float m1 = smoothstep(0.0, 1.0, clamp(uMorph, 0.0, 1.0));
  float m2 = smoothstep(0.0, 1.0, clamp(uMorph - 1.0, 0.0, 1.0));
  vec3 p = mix(mix(cloud, spiral, m1), sphere, m2);

  // vortex: differential rotation around Y (inner faster)
  float rad = length(p.xz);
  float ang = uClock * uVortex * (0.35 + 0.9 / (0.35 + rad / uRadius));
  float c = cos(ang), s = sin(ang);
  p.xz = mat2(c, -s, s, c) * p.xz;

  // turbulence (mids) and per-band outward push
  vec3 n = vec3(
    snoise(p * 0.9 + vec3(uClock * 0.21, 0.0, 0.0)),
    snoise(p * 0.9 + vec3(0.0, uClock * 0.17, 4.3)),
    snoise(p * 0.9 + vec3(7.7, 0.0, uClock * 0.19))
  );
  p += n * uRadius * (0.04 + uTurbulence * (0.05 + uMids * 0.22));
  vec3 outward = normalize(p + vec3(1e-4));
  p += outward * level * uReact * uRadius * 0.28;
  p *= 1.0 + uPulse * (0.5 + 0.5 * s1);
  p += outward * uIdle * 0.05 * uRadius * sin(uClock * 0.7 + s2 * 6.28);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(0.5, -mv.z);
  float size = 1.8 * uSize * uPointScale * (0.55 + level * 1.4 + uPulse * 1.5) * (0.6 + s3 * 0.8) * (6.0 / depth);
  // points can't be smaller than a pixel: fade them instead, so coverage (and the look)
  // stays the same at every output resolution
  vCover = clamp(size * size, 0.0, 1.0);
  gl_PointSize = max(size, 1.0);
  vLevel = level;
  vBand = band;
  vSeed = s1;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform float uGradient;
uniform float uGlow;
varying float vLevel;
varying float vBand;
varying float vSeed;
varying float vCover;
${GLSL_GRADIENT}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float soft = exp(-d * 14.0);
  vec3 col = bfGradient(uGradient, vBand, vLevel, uPrimary, uSecondary);
  float a = (0.16 + vLevel * 1.1) * soft * uGlow * (0.7 + 0.3 * vSeed) * vCover;
  gl_FragColor = vec4(col * a, 1.0);
}
`;

class ParticleCloudScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly specData = new Uint8Array(DISPLAY_BANDS);
  private readonly specTex: THREE.DataTexture;
  private readonly mat: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private count = 0;
  private readonly baseCount: number;
  private clock = 0;
  private readonly pulse = new Spring(0, 200, 18);
  private kickSeen = -1;
  private kickHold = 0;

  constructor(env: SceneEnv) {
    this.baseCount = env.quality.detail === 'high' ? 70000 : 36000;
    this.specTex = new THREE.DataTexture(this.specData, DISPLAY_BANDS, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.specTex.magFilter = THREE.LinearFilter;
    this.specTex.minFilter = THREE.LinearFilter;
    this.specTex.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSpectrum: { value: this.specTex },
        uMorph: { value: 0 },
        uArms: { value: 3 },
        uTwist: { value: 2.4 },
        uRadius: { value: 1.6 },
        uClock: { value: 0 },
        uVortex: { value: 0.2 },
        uTurbulence: { value: 0.5 },
        uMids: { value: 0 },
        uReact: { value: 1 },
        uPulse: { value: 0 },
        uSize: { value: 1 },
        uPointScale: { value: 1 },
        uIdle: { value: 1 },
        uPrimary: { value: new THREE.Color() },
        uSecondary: { value: new THREE.Color() },
        uGradient: { value: 2 },
        uGlow: { value: 1 },
      },
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.mat);
    this.points.frustumCulled = false;
    this.root.add(this.points);
  }

  private build(count: number): void {
    this.count = count;
    const random = rng(0x5eed + 6);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = random();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.points.geometry.dispose();
    this.points.geometry = g;
  }

  update(ctx: SceneFrameContext): void {
    const p = ctx.params;
    const a = ctx.audio;
    const dt = ctx.dt;
    const motion = ctx.reducedMotion ? 0.45 : 1;
    const intensity = p.num('motionIntensity');
    const count = Math.max(2000, Math.min(150000, Math.round(this.baseCount * p.num('density') * ctx.quality.particles / (ctx.quality.detail === 'high' ? 1 : 0.6))));
    if (Math.abs(count - this.count) > this.count * 0.05) this.build(count);

    for (let b = 0; b < DISPLAY_BANDS; b++) this.specData[b] = Math.min(255, Math.round((a.spectrum[b] / 1.3) * 255));
    this.specTex.needsUpdate = true;

    const dir = directionSign(p.str('direction'));
    this.clock += dt * p.num('speed') * motion * dir;
    if (a.kickCount !== this.kickSeen) {
      const first = this.kickSeen < 0;
      this.kickSeen = a.kickCount;
      if (!first) this.kickHold = Math.min(1, a.kick + 0.2);
    }
    this.kickHold = Math.max(0, this.kickHold - dt * 5);
    const pulse = this.pulse.step((this.kickHold * 0.09 + a.bass * 0.05 * intensity) * motion, dt);

    // automatic morph cycling (deterministic in the visual clock) on top of the shape value
    const auto = p.num('autoMorph');
    const morph = Math.min(2, Math.max(0, p.num('shape') + auto * (1 - Math.cos(ctx.clock * 0.18)) ));

    const scale = p.num('scale');
    const u = this.mat.uniforms;
    u.uMorph.value = morph;
    u.uArms.value = Math.max(1, Math.round(p.num('arms')));
    u.uTwist.value = 1 + p.num('complexity') * 4;
    u.uRadius.value = 1.6 * scale;
    u.uClock.value = this.clock;
    u.uVortex.value = 0.25 * p.num('rotation');
    u.uTurbulence.value = p.num('deformation');
    u.uMids.value = a.mids * intensity * motion;
    u.uReact.value = intensity;
    u.uPulse.value = pulse;
    u.uSize.value = p.num('particleSize');
    u.uPointScale.value = ctx.height / 900;
    u.uIdle.value = 1 - a.activity;
    (u.uPrimary.value as THREE.Color).copy(ctx.palette.primary);
    (u.uSecondary.value as THREE.Color).copy(ctx.palette.secondary);
    u.uGradient.value = ctx.palette.gradient;
    u.uGlow.value = p.num('glow');

    const cam = applyCamera(ctx, { fitRadius: 1.75 * scale, elevation: p.num('tilt'), fov: 50, parallax: 0.6 });
    this.telemetry.rotation = wrapDegrees(cam.azimuth);
    this.telemetry.tilt = cam.elevation;
  }

  dispose(): void {
    disposeTree(this.root);
    this.specTex.dispose();
  }
}

export const create: SceneFactory = (env) => new ParticleCloudScene(env);
