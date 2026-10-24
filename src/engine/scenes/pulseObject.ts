/**
 * SCENE 01 — PULSE OBJECT (ported from the v1 R3F mode; defaults reproduce the original)
 *
 * A dense icosphere displaced in the vertex shader by three octaves of simplex noise and
 * shaded as a "topographic" object: iso-lines of the displacement field plus a fresnel
 * rim in the primary colour, inside a particle shell and a dial ring.
 *
 *   bass → scale (spring) + large lobes · kick → impulse + rim · mids → folding + flow
 *   treble → fine ripple + particle shell · snare → ring ripple across the surface
 */
import * as THREE from 'three';
import { Spring } from '../../audio/dsp/envelope';
import { applyCamera } from '../camera';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { SIMPLEX_NOISE_3D, directionSign, disposeTree, hash01, wrapDegrees } from './common';

const BLOB_VERTEX = /* glsl */ `
uniform float uPhase;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uIdle;
uniform float uScale;
uniform float uSnare;
uniform float uSnarePhase;
uniform vec3 uSnareDir;
uniform float uDeform;
varying vec3 vView;
varying float vDisp;
varying vec3 vDir;
${SIMPLEX_NOISE_3D}
void main() {
  vec3 p = normalize(position);
  float t = uPhase;
  float n1 = snoise(p * 1.15 + vec3(0.0, t * 0.55, t * 0.32));
  float n2 = snoise(p * 2.6 + vec3(t * 0.8, -t * 0.62, 3.1));
  float n3 = snoise(p * 7.5 + vec3(-t * 1.9, t * 1.4, t * 1.1));
  float d = n1 * (0.06 + 0.05 * uIdle + 0.12 * uBass)
          + n2 * (0.012 + 0.11 * uMid)
          + n3 * (0.028 * uHigh);
  d *= uDeform;
  float ang = acos(clamp(dot(p, uSnareDir), -1.0, 1.0));
  float ring = exp(-pow((ang - uSnarePhase) * 3.2, 2.0));
  d += uSnare * 0.09 * ring;
  vec3 displaced = p * (uScale + d);
  vDisp = d;
  vDir = p;
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const BLOB_FRAGMENT = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uLine;
uniform vec3 uBase;
uniform float uDensity;
uniform float uShift;
uniform float uGlow;
uniform float uLineBoost;
varying vec3 vView;
varying float vDisp;
varying vec3 vDir;
void main() {
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 v = normalize(-vView);
  float facing = abs(dot(n, v));
  float fres = pow(1.0 - facing, 2.4);

  // topographic iso-lines of the displacement field, ~1px wide at any zoom
  float h = vDisp * uDensity + uShift;
  float w = max(fwidth(h), 1e-4);
  float dist = abs(fract(h - 0.5) - 0.5) / w;
  float contour = 1.0 - smoothstep(0.35, 1.35, dist);

  // a faint latitude graticule anchors the form like a technical drawing
  float lat = vDir.y * 9.0;
  float lw = max(fwidth(lat), 1e-4);
  float grat = (1.0 - smoothstep(0.3, 1.2, abs(fract(lat - 0.5) - 0.5) / lw)) * 0.12;

  vec3 col = uBase * (0.55 + 0.45 * facing);
  col += uAccent * fres * (0.2 + 0.75 * uGlow);
  col += uLine * contour * (0.32 + 0.55 * uLineBoost) * (0.45 + 0.55 * facing);
  col += uLine * grat;
  gl_FragColor = vec4(col, 1.0);
}
`;

const SHELL_VERTEX = /* glsl */ `
attribute float aSeed;
uniform float uPhase;
uniform float uHigh;
uniform float uHat;
uniform float uIdle;
uniform float uPixelRatio;
uniform float uScale;
varying float vAlpha;
varying float vSeed;
${SIMPLEX_NOISE_3D}
void main() {
  float light = clamp(uHigh * 1.05 + uHat * 0.7, 0.0, 1.4);
  float on = smoothstep(aSeed * 0.95, aSeed * 0.95 + 0.18, light);
  float wobble = snoise(position * 2.2 + vec3(uPhase * 0.9)) * (0.025 + 0.07 * uHigh);
  vec3 p = position * (uScale * 0.92 + wobble + uHat * 0.06 * aSeed);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = clamp(-mv.z, 1.0, 20.0);
  gl_PointSize = (1.0 + 2.6 * on) * uPixelRatio * (6.5 / depth);
  vAlpha = 0.07 + 0.08 * uIdle + on * 0.85;
  vSeed = aSeed;
}
`;

const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uLine;
varying float vAlpha;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float soft = 1.0 - smoothstep(0.25, 0.5, r);
  vec3 col = mix(uLine, uAccent, step(0.72, vSeed));
  gl_FragColor = vec4(col * vAlpha * soft, 1.0);
}
`;

/** world size of the unit blob */
const BODY_SCALE = 1.18;
const WHITE = new THREE.Color(1, 1, 1);

function makeShell(count: number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    const radius = 1.32 + 0.55 * Math.pow(hash01(i), 1.6);
    pos[i * 3] = Math.cos(th) * r * radius;
    pos[i * 3 + 1] = y * radius;
    pos[i * 3 + 2] = Math.sin(th) * r * radius;
    seed[i] = hash01(i * 7.13 + 1.7);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  return g;
}

function makeDial(): THREE.BufferGeometry {
  const ticks = 120;
  const circleSegs = 240;
  const verts: number[] = [];
  for (let i = 0; i < circleSegs; i++) {
    const a0 = (i / circleSegs) * Math.PI * 2;
    const a1 = ((i + 1) / circleSegs) * Math.PI * 2;
    verts.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0);
  }
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2;
    const len = i % 30 === 0 ? 0.08 : i % 5 === 0 ? 0.045 : 0.022;
    verts.push(Math.cos(a), Math.sin(a), 0, Math.cos(a) * (1 + len), Math.sin(a) * (1 + len), 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return g;
}

class PulseObjectScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly body = new THREE.Group();
  private readonly blob: THREE.Mesh;
  private shell: THREE.Points;
  private readonly dial: THREE.LineSegments;
  private readonly blobMat: THREE.ShaderMaterial;
  private readonly shellMat: THREE.ShaderMaterial;
  private readonly dialMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false });
  private shellCount = 0;
  private readonly baseParticles: number;
  private phase = 0;
  private yaw = 0;
  private tiltX = 0;
  private tiltY = 0;
  private shift = 0;
  private readonly scale = new Spring(1, 260, 24);
  private snareSeen = -1;
  private snareAge = 10;
  private readonly snareDir = new THREE.Vector3(0, 1, 0);

  constructor(env: SceneEnv) {
    this.baseParticles = env.quality.detail === 'high' ? 5200 : 2400;
    this.blobMat = new THREE.ShaderMaterial({
      vertexShader: BLOB_VERTEX,
      fragmentShader: BLOB_FRAGMENT,
      uniforms: {
        uPhase: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uHigh: { value: 0 },
        uIdle: { value: 1 },
        uScale: { value: 1 },
        uSnare: { value: 0 },
        uSnarePhase: { value: 0 },
        uSnareDir: { value: new THREE.Vector3(0, 1, 0) },
        uDeform: { value: 1 },
        uAccent: { value: new THREE.Color() },
        uLine: { value: new THREE.Color() },
        uBase: { value: new THREE.Color() },
        uDensity: { value: 42 },
        uShift: { value: 0 },
        uGlow: { value: 0 },
        uLineBoost: { value: 0 },
      },
    });
    this.shellMat = new THREE.ShaderMaterial({
      vertexShader: SHELL_VERTEX,
      fragmentShader: SHELL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPhase: { value: 0 },
        uHigh: { value: 0 },
        uHat: { value: 0 },
        uIdle: { value: 1 },
        uPixelRatio: { value: 1 },
        uScale: { value: 1 },
        uAccent: { value: new THREE.Color() },
        uLine: { value: new THREE.Color() },
      },
    });
    this.blob = new THREE.Mesh(new THREE.IcosahedronGeometry(1, env.quality.detail === 'high' ? 64 : 32), this.blobMat);
    this.shell = new THREE.Points(new THREE.BufferGeometry(), this.shellMat);
    this.dial = new THREE.LineSegments(makeDial(), this.dialMat);
    this.body.add(this.blob, this.shell);
    this.root.add(this.body, this.dial);
  }

  private ensureShell(density: number): void {
    const count = Math.max(200, Math.round(this.baseParticles * density));
    if (count === this.shellCount) return;
    this.shell.geometry.dispose();
    this.shell.geometry = makeShell(count);
    this.shellCount = count;
  }

  update(ctx: SceneFrameContext): void {
    const p = ctx.params;
    const a = ctx.audio;
    const dt = ctx.dt;
    const intensity = p.num('motionIntensity');
    const motion = ctx.reducedMotion ? 0.45 : 1;
    const act = a.activity;
    const bass = a.bass * intensity;
    const mid = a.mids * intensity;
    const high = a.treble * intensity;
    const kick = a.kick;
    const speed = p.num('speed');

    this.ensureShell(p.num('density') * ctx.quality.particles / (ctx.quality.detail === 'high' ? 1 : 0.6));

    this.phase += dt * (0.18 + 0.55 * mid * act) * motion * speed;
    this.shift += dt * (0.05 + 0.25 * a.flux * act) * motion * speed;

    if (a.snareCount !== this.snareSeen) {
      const first = this.snareSeen < 0;
      this.snareSeen = a.snareCount;
      const k = this.snareSeen * 2.399963;
      const y = Math.cos(k * 0.61);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      this.snareDir.set(Math.cos(k) * r, y, Math.sin(k) * r);
      if (!first) this.snareAge = 0;
    }
    this.snareAge += dt;

    const sc = this.scale.step(1 + (0.13 * bass + 0.11 * kick) * motion, dt);

    const u = this.blobMat.uniforms;
    u.uPhase.value = this.phase;
    u.uBass.value = bass * motion;
    u.uMid.value = mid * motion;
    u.uHigh.value = high * motion;
    u.uIdle.value = 1 - act;
    u.uScale.value = sc;
    u.uSnare.value = a.snare * motion;
    u.uSnarePhase.value = Math.min(Math.PI, this.snareAge * 5.5);
    (u.uSnareDir.value as THREE.Vector3).copy(this.snareDir);
    u.uDeform.value = p.num('deformation');
    const accent = u.uAccent.value as THREE.Color;
    accent.copy(ctx.palette.primary);
    (u.uLine.value as THREE.Color).copy(ctx.palette.secondary);
    const bg = ctx.palette.background;
    (u.uBase.value as THREE.Color).setRGB(bg.r * 1.6 + 0.012, bg.g * 1.6 + 0.012, bg.b * 1.6 + 0.012);
    u.uDensity.value = 20 + p.num('complexity') * 44;
    u.uShift.value = this.shift;
    u.uGlow.value = Math.min(1.1, 0.3 * bass + 0.7 * kick);
    u.uLineBoost.value = Math.min(1, 0.6 * mid + 0.5 * kick);

    const su = this.shellMat.uniforms;
    su.uPhase.value = this.phase;
    su.uHigh.value = high;
    su.uHat.value = a.hat * motion;
    su.uIdle.value = 1 - act;
    // point sizes follow the output height, so a 4K export looks like the live view
    su.uPixelRatio.value = ctx.height / 900;
    su.uScale.value = sc;
    (su.uAccent.value as THREE.Color).copy(accent);
    (su.uLine.value as THREE.Color).copy(ctx.palette.secondary);

    const dir = directionSign(p.str('direction'));
    this.yaw += dt * 0.12 * p.num('rotation') * motion * dir;
    const px = ctx.exporting || ctx.reducedMotion ? 0 : ctx.pointer.x;
    const py = ctx.exporting || ctx.reducedMotion ? 0 : ctx.pointer.y;
    this.tiltX += (py * 0.18 - this.tiltX) * Math.min(1, dt * 2.5);
    this.tiltY += (px * 0.25 - this.tiltY) * Math.min(1, dt * 2.5);
    const rx = 0.32 + this.tiltX + Math.sin(this.phase * 0.21) * 0.06;
    const bodyScale = BODY_SCALE * p.num('scale');
    this.body.scale.setScalar(bodyScale);
    this.body.rotation.set(rx, this.yaw + this.tiltY, 0.08);
    this.dial.rotation.z = -this.yaw * 0.5;
    this.dial.scale.setScalar(bodyScale * 2.08 + 0.06 * kick * motion);
    this.dialMat.opacity = Math.min(1, 0.16 + 0.45 * kick + 0.1 * bass);
    this.dialMat.color.copy(WHITE).lerp(accent, Math.min(1, kick * 1.4));

    applyCamera(ctx, { fitRadius: 2.05 * p.num('scale'), fov: 35 });
    this.telemetry.rotation = wrapDegrees(((this.yaw + this.tiltY) * 180) / Math.PI);
    this.telemetry.tilt = (rx * 180) / Math.PI;
  }

  dispose(): void {
    disposeTree(this.root);
  }
}

export const create: SceneFactory = (env) => new PulseObjectScene(env);
