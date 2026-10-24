/**
 * SCENE 05 — COSMIC RINGS
 *
 * Concentric polar curves rendered as soft-glow ribbons (the glow profile is computed in
 * the fragment shader, no post-processing required). Ring k listens to its own frequency
 * region (inner = low, outer = high); around the ring the local spectrum is folded into
 * `symmetry` mirrored segments, which gives a kaleidoscopic, symmetric composition.
 *
 *   per-ring band energy → radius + ribbon width + brightness
 *   kick  → a spring impulse that ripples outward ring by ring (stiffness falls outward)
 *   mids  → rose-curve petals · rotation → each layer turns at its own rate and direction
 *   bass  → the shader-driven core
 */
import * as THREE from 'three';
import { DISPLAY_BANDS } from '../../audio/analysis/frame';
import { Spring } from '../../audio/dsp/envelope';
import { applyCamera } from '../camera';
import { GLSL_GRADIENT } from '../colors';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { SIMPLEX_NOISE_3D, directionSign, disposeTree, wrapDegrees } from './common';
import { MAX_RINGS } from './defs/cosmicRings';

const RING_VERT = /* glsl */ `
attribute vec3 aData; // theta, side (-1..1), ring index
uniform sampler2D uSpectrum;
uniform float uRingRot[${MAX_RINGS}];
uniform float uRingLevel[${MAX_RINGS}];
uniform float uRingExpand[${MAX_RINGS}];
uniform float uRingCount;
uniform float uSymmetry;
uniform float uDeform;
uniform float uPetals;
uniform float uPhase;
uniform float uMids;
uniform float uBaseR;
uniform float uGap;
uniform float uWidth;
uniform float uDepth;
varying float vSide;
varying float vT;
varying float vLevel;
varying float vFreq;
void main() {
  int ki = int(aData.z + 0.5);
  float t = aData.z / max(1.0, uRingCount - 1.0);
  float theta = aData.x + uRingRot[ki];
  // kaleidoscopic fold: the local spectrum around this ring's band, mirrored per segment
  float local = fract(aData.x * uSymmetry / 6.28318530718);
  float mirrored = 1.0 - abs(2.0 * local - 1.0);
  float freq = clamp(t * 0.9 + (mirrored - 0.5) * 0.22, 0.0, 1.0);
  float spec = texture2D(uSpectrum, vec2(freq, 0.5)).r * 1.3;
  float amp = uDeform * (0.26 - 0.12 * t);
  float petals = sin(aData.x * uSymmetry * (1.0 + floor(uPetals * 3.0)) + uPhase * (1.0 + t * 0.6));
  float r = (uBaseR + aData.z * uGap) * (1.0 + uRingExpand[ki]);
  r += pow(spec, 1.2) * amp + petals * uMids * 0.045 * uPetals;
  float w = uWidth * (0.55 + uRingLevel[ki] * 1.8 + spec * 0.6);
  vec2 dir = vec2(cos(theta), sin(theta));
  vec3 p = vec3(dir * (r + aData.y * w), (t - 0.5) * uDepth);
  vSide = aData.y;
  vT = t;
  vLevel = clamp(uRingLevel[ki] * 0.8 + spec * 0.5, 0.0, 1.4);
  vFreq = freq;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform float uGradient;
uniform float uGlow;
varying float vSide;
varying float vT;
varying float vLevel;
varying float vFreq;
${GLSL_GRADIENT}
void main() {
  float s2 = vSide * vSide;
  float halo = exp(-s2 * 4.0);
  float core = exp(-s2 * 38.0);
  vec3 col = bfGradient(uGradient, mix(vT, vFreq, 0.35), vLevel, uPrimary, uSecondary);
  float a = (halo * 0.35 * uGlow + core) * (0.22 + 0.9 * vLevel);
  gl_FragColor = vec4(col * a, 1.0);
}
`;

const CORE_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CORE_FRAG = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform float uGradient;
uniform float uBass;
uniform float uPhase;
uniform float uCore;
varying vec2 vP;
${SIMPLEX_NOISE_3D}
${GLSL_GRADIENT}
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float a = atan(vP.y, vP.x);
  float swirl = snoise(vec3(cos(a) * 1.5, sin(a) * 1.5 + r * 2.0, uPhase * 0.4 - r * 1.5));
  float body = (1.0 - smoothstep(0.0, 1.0, r)) * (0.35 + 0.65 * smoothstep(-0.6, 0.9, swirl));
  float rim = exp(-pow((r - 0.92) * 14.0, 2.0)) * 0.6;
  vec3 col = bfGradient(uGradient, r * 0.4, 0.4 + uBass * 0.6, uPrimary, uSecondary);
  gl_FragColor = vec4(col * (body * (0.18 + 0.9 * uBass) + rim * (0.2 + uBass)) * uCore, 1.0);
}
`;

class CosmicRingsScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly specData = new Uint8Array(DISPLAY_BANDS);
  private readonly specTex: THREE.DataTexture;
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly coreMat: THREE.ShaderMaterial;
  private readonly ringsMesh: THREE.Mesh;
  private readonly core: THREE.Mesh;
  private readonly segments: number;
  private ringCount = 0;
  private readonly rot = new Float32Array(MAX_RINGS);
  private readonly level = new Float32Array(MAX_RINGS);
  private readonly expand = new Float32Array(MAX_RINGS);
  private readonly springs: Spring[] = [];
  private kickSeen = -1;
  private kickHold = 0;
  private phase = 0;

  constructor(env: SceneEnv) {
    this.segments = env.quality.detail === 'high' ? 320 : 192;
    this.specTex = new THREE.DataTexture(this.specData, DISPLAY_BANDS, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.specTex.magFilter = THREE.LinearFilter;
    this.specTex.minFilter = THREE.LinearFilter;
    this.specTex.needsUpdate = true;
    for (let i = 0; i < MAX_RINGS; i++) this.springs.push(new Spring(0, 320 - (i / MAX_RINGS) * 220, 20));
    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uSpectrum: { value: this.specTex },
        uRingRot: { value: this.rot },
        uRingLevel: { value: this.level },
        uRingExpand: { value: this.expand },
        uRingCount: { value: 1 },
        uSymmetry: { value: 6 },
        uDeform: { value: 1 },
        uPetals: { value: 0.5 },
        uPhase: { value: 0 },
        uMids: { value: 0 },
        uBaseR: { value: 0.35 },
        uGap: { value: 0.1 },
        uWidth: { value: 0.02 },
        uDepth: { value: 0.3 },
        uPrimary: { value: new THREE.Color() },
        uSecondary: { value: new THREE.Color() },
        uGradient: { value: 2 },
        uGlow: { value: 1 },
      },
    });
    this.coreMat = new THREE.ShaderMaterial({
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPrimary: { value: new THREE.Color() },
        uSecondary: { value: new THREE.Color() },
        uGradient: { value: 2 },
        uBass: { value: 0 },
        uPhase: { value: 0 },
        uCore: { value: 1 },
      },
    });
    this.ringsMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.ringMat);
    this.ringsMesh.frustumCulled = false;
    this.core = new THREE.Mesh(new THREE.CircleGeometry(1, 96), this.coreMat);
    this.root.add(this.core, this.ringsMesh);
  }

  private build(count: number): void {
    this.ringCount = count;
    const M = this.segments;
    const data = new Float32Array(count * (M + 1) * 2 * 3);
    const index: number[] = [];
    let v = 0;
    for (let k = 0; k < count; k++) {
      const base = v;
      for (let j = 0; j <= M; j++) {
        const theta = (j / M) * Math.PI * 2;
        for (const side of [-1, 1]) {
          data[v * 3] = theta;
          data[v * 3 + 1] = side;
          data[v * 3 + 2] = k;
          v++;
        }
        if (j < M) {
          const a = base + j * 2;
          index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    // three needs a "position" attribute to draw; the shader only uses aData
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.length), 3));
    g.setAttribute('aData', new THREE.BufferAttribute(data, 3));
    g.setIndex(index);
    this.ringsMesh.geometry.dispose();
    this.ringsMesh.geometry = g;
  }

  update(ctx: SceneFrameContext): void {
    const p = ctx.params;
    const a = ctx.audio;
    const dt = ctx.dt;
    const motion = ctx.reducedMotion ? 0.45 : 1;
    const intensity = p.num('motionIntensity');
    const count = Math.max(2, Math.min(MAX_RINGS, Math.round(p.num('rings'))));
    if (count !== this.ringCount) this.build(count);

    for (let b = 0; b < DISPLAY_BANDS; b++) this.specData[b] = Math.min(255, Math.round((a.spectrum[b] / 1.3) * 255 * Math.min(1.5, intensity)));
    this.specTex.needsUpdate = true;

    if (a.kickCount !== this.kickSeen) {
      const first = this.kickSeen < 0;
      this.kickSeen = a.kickCount;
      if (!first) this.kickHold = Math.min(1, a.kick + 0.25);
    }
    this.kickHold = Math.max(0, this.kickHold - dt * 6);
    const dir = directionSign(p.str('direction'));
    const rotSpeed = p.num('rotation');
    for (let k = 0; k < count; k++) {
      const t = k / Math.max(1, count - 1);
      // band region of this ring (inner = low)
      const b0 = Math.floor(t * 0.9 * (DISPLAY_BANDS - 1));
      const b1 = Math.min(DISPLAY_BANDS - 1, b0 + 5);
      let s = 0;
      for (let b = b0; b <= b1; b++) s += a.spectrum[b];
      this.level[k] = Math.min(1.3, (s / (b1 - b0 + 1)) * intensity);
      const alt = k % 2 === 0 ? 1 : -1;
      this.rot[k] += dt * rotSpeed * motion * dir * alt * (0.08 + 0.03 * (k % 3) + 0.1 * this.level[k]);
      const kick = (this.kickHold * 0.16 + a.kick * 0.04) * (1 - t * 0.45) * motion;
      this.expand[k] = this.springs[k].step(kick, dt);
    }
    this.phase += dt * (0.4 + 0.8 * a.mids) * motion * p.num('speed') * dir;

    const scale = p.num('scale');
    const outer = 1.65 * scale;
    const baseR = outer * 0.22;
    const u = this.ringMat.uniforms;
    u.uRingCount.value = count;
    u.uSymmetry.value = Math.max(1, Math.round(p.num('symmetry')));
    u.uDeform.value = p.num('deformation') * scale;
    u.uPetals.value = p.num('complexity');
    u.uPhase.value = this.phase;
    u.uMids.value = a.mids * intensity;
    u.uBaseR.value = baseR;
    u.uGap.value = (outer - baseR) / Math.max(1, count - 1);
    u.uWidth.value = 0.018 * scale * p.num('lineWidth');
    u.uDepth.value = p.num('depth') * scale;
    (u.uPrimary.value as THREE.Color).copy(ctx.palette.primary);
    (u.uSecondary.value as THREE.Color).copy(ctx.palette.secondary);
    u.uGradient.value = ctx.palette.gradient;
    u.uGlow.value = p.num('glow');

    const cu = this.coreMat.uniforms;
    (cu.uPrimary.value as THREE.Color).copy(ctx.palette.primary);
    (cu.uSecondary.value as THREE.Color).copy(ctx.palette.secondary);
    cu.uGradient.value = ctx.palette.gradient;
    cu.uBass.value = Math.min(1.4, (a.bass * 0.8 + a.sub * 0.4) * intensity);
    cu.uPhase.value = this.phase;
    cu.uCore.value = p.num('core');
    this.core.scale.setScalar(baseR * 0.82 * (1 + this.expand[0] * 0.6));
    this.core.visible = p.num('core') > 0.001;

    const cam = applyCamera(ctx, { fitRadius: outer + 0.25 * scale, elevation: p.num('tilt'), fov: 40, parallax: 0.4 });
    this.telemetry.rotation = wrapDegrees(cam.azimuth + (this.rot[0] * 180) / Math.PI);
    this.telemetry.tilt = cam.elevation;
  }

  dispose(): void {
    disposeTree(this.root);
    this.specTex.dispose();
  }
}

export const create: SceneFactory = (env) => new CosmicRingsScene(env);
