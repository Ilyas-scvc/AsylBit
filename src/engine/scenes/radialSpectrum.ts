/**
 * SCENE 02 — RADIAL SPECTRUM (ported from the v1 R3F mode; defaults reproduce the original)
 *
 * 192 wedge bars on a log frequency axis (30 Hz–16 kHz), mirrored; each band has its own
 * inertia (lows big and slow, highs small and fast). Past spectra recede as a tunnel, an
 * oscilloscope ring sits inside, hats emit particles from their band, snares send a shock ring.
 */
import * as THREE from 'three';
import { DISPLAY_BANDS, WAVE_POINTS } from '../../audio/analysis/frame';
import { Spring } from '../../audio/dsp/envelope';
import { applyCamera } from '../camera';
import { gradientColor } from '../colors';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { directionSign, disposeTree, hash01, wrapDegrees } from './common';

const N = DISPLAY_BANDS * 2;
const R = 1.0;
const DZ = 0.2;
const PUSH_INTERVAL = 1 / 30;
const SHOCK_SEGMENTS = 160;

const COS = new Float32Array(N);
const SIN = new Float32Array(N);
const COS_L = new Float32Array(N);
const SIN_L = new Float32Array(N);
const COS_R = new Float32Array(N);
const SIN_R = new Float32Array(N);
const BAND = new Uint8Array(N);
const MAXLEN = new Float32Array(DISPLAY_BANDS);
const HALF_WIDTH = (Math.PI / N) * 0.42;
for (let i = 0; i < N; i++) {
  const a = Math.PI / 2 - (2 * Math.PI * (i + 0.5)) / N;
  COS[i] = Math.cos(a);
  SIN[i] = Math.sin(a);
  COS_L[i] = Math.cos(a - HALF_WIDTH);
  SIN_L[i] = Math.sin(a - HALF_WIDTH);
  COS_R[i] = Math.cos(a + HALF_WIDTH);
  SIN_R[i] = Math.sin(a + HALF_WIDTH);
  BAND[i] = i < DISPLAY_BANDS ? i : N - 1 - i;
}
for (let b = 0; b < DISPLAY_BANDS; b++) MAXLEN[b] = 1.15 - 0.62 * (b / (DISPLAY_BANDS - 1));

function dynamicGeometry(vertexCount: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  const col = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  col.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', pos);
  g.setAttribute('color', col);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 14);
  return g;
}

const additive = () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });

class RadialSpectrumScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly group = new THREE.Group();
  private readonly bars: THREE.Mesh;
  private readonly caps: THREE.LineSegments;
  private rings: THREE.LineSegments;
  private readonly scope: THREE.LineSegments;
  private readonly shock: THREE.LineSegments;
  private particles: THREE.Points;
  private readonly shockMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  private K: number;
  private P = 0;
  private history = new Float32Array(0);
  private head = 0;
  private timer = 0;
  private vel = new Float32Array(0);
  private life = new Float32Array(0);
  private maxLife = new Float32Array(0);
  private next = 0;
  private spin = 0;
  private tiltX = 0;
  private tiltY = 0;
  private readonly radius = new Spring(R, 300, 26);
  private snareSeen = -1;
  private hatSeen = -1;
  private shockAge = 10;
  private shockStrength = 0;
  private emit = 0;
  private spawnCount = 0;
  private readonly baseParticles: number;
  private readonly tmp = new THREE.Color();

  constructor(env: SceneEnv) {
    this.K = env.quality.detail === 'high' ? 34 : 18;
    this.baseParticles = env.quality.detail === 'high' ? 900 : 400;
    const barsGeo = dynamicGeometry(N * 4);
    const index: number[] = [];
    for (let i = 0; i < N; i++) {
      const v = i * 4;
      index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
    }
    barsGeo.setIndex(index);
    this.bars = new THREE.Mesh(
      barsGeo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.caps = new THREE.LineSegments(dynamicGeometry(N * 2), additive());
    this.rings = new THREE.LineSegments(new THREE.BufferGeometry(), additive());
    this.scope = new THREE.LineSegments(dynamicGeometry(WAVE_POINTS * 2), additive());
    const sv: number[] = [];
    for (let i = 0; i < SHOCK_SEGMENTS; i++) {
      const a0 = (i / SHOCK_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / SHOCK_SEGMENTS) * Math.PI * 2;
      sv.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3));
    this.shock = new THREE.LineSegments(sg, this.shockMat);
    this.particles = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 2.4, sizeAttenuation: false, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.group.add(this.rings, this.bars, this.caps, this.scope, this.shock, this.particles);
    this.root.add(this.group);
    this.allocRings(this.K);
  }

  private allocRings(K: number): void {
    this.K = K;
    this.rings.geometry.dispose();
    this.rings.geometry = dynamicGeometry(K * N * 2);
    this.history = new Float32Array(K * DISPLAY_BANDS);
    this.head = 0;
  }

  private allocParticles(P: number): void {
    if (P === this.P) return;
    this.P = P;
    this.particles.geometry.dispose();
    const g = dynamicGeometry(P);
    (g.attributes.position.array as Float32Array).fill(999);
    this.particles.geometry = g;
    this.vel = new Float32Array(P * 3);
    this.life = new Float32Array(P);
    this.maxLife = new Float32Array(P).fill(1);
    this.next = 0;
  }

  update(ctx: SceneFrameContext): void {
    const p = ctx.params;
    const a = ctx.audio;
    const dt = ctx.dt;
    const motion = ctx.reducedMotion ? 0.45 : 1;
    const intensity = p.num('motionIntensity');
    const primary = ctx.palette.primary;
    const secondary = ctx.palette.secondary;
    const mode = ctx.palette.gradient;
    const spec = a.spectrum;
    const scale = p.num('scale');

    const ringCount = Math.max(6, Math.round((ctx.quality.detail === 'high' ? 34 : 18) * Math.max(0.2, p.num('depth'))));
    if (ringCount !== this.K) this.allocRings(ringCount);
    this.allocParticles(Math.max(32, Math.round(this.baseParticles * p.num('density') * (ctx.quality.particles / (ctx.quality.detail === 'high' ? 1 : 0.6)))));

    const r0 = this.radius.step(R * (1 + (0.1 * a.bass * intensity + 0.09 * a.kick) * motion), dt);

    const bars = this.bars.geometry;
    const caps = this.caps.geometry;
    const bp = bars.attributes.position.array as Float32Array;
    const bc = bars.attributes.color.array as Float32Array;
    const cp = caps.attributes.position.array as Float32Array;
    const cc = caps.attributes.color.array as Float32Array;
    const lenScale = ctx.reducedMotion ? 0.7 : 1;
    for (let i = 0; i < N; i++) {
      const b = BAND[i];
      const v = spec[b];
      const len = (0.025 + Math.pow(v, 1.3) * MAXLEN[b] * intensity) * lenScale;
      const inner = r0;
      const outer = r0 + len;
      const o = i * 12;
      bp[o] = COS_L[i] * inner;
      bp[o + 1] = SIN_L[i] * inner;
      bp[o + 2] = 0;
      bp[o + 3] = COS_R[i] * inner;
      bp[o + 4] = SIN_R[i] * inner;
      bp[o + 5] = 0;
      bp[o + 6] = COS_L[i] * outer;
      bp[o + 7] = SIN_L[i] * outer;
      bp[o + 8] = 0;
      bp[o + 9] = COS_R[i] * outer;
      bp[o + 10] = SIN_R[i] * outer;
      bp[o + 11] = 0;
      const k = Math.min(1, v);
      const dim = 0.1 + 0.15 * k;
      const bright = 0.35 + 0.65 * k;
      gradientColor(mode, b / (DISPLAY_BANDS - 1), k, primary, secondary, this.tmp);
      bc[o] = bc[o + 3] = dim;
      bc[o + 1] = bc[o + 4] = dim;
      bc[o + 2] = bc[o + 5] = dim;
      bc[o + 6] = bc[o + 9] = this.tmp.r * bright;
      bc[o + 7] = bc[o + 10] = this.tmp.g * bright;
      bc[o + 8] = bc[o + 11] = this.tmp.b * bright;
      const pk = r0 + (0.025 + Math.pow(a.peaks[b], 1.3) * MAXLEN[b] * intensity) * lenScale + 0.025;
      const q = i * 6;
      cp[q] = COS_L[i] * pk;
      cp[q + 1] = SIN_L[i] * pk;
      cp[q + 2] = 0;
      cp[q + 3] = COS_R[i] * pk;
      cp[q + 4] = SIN_R[i] * pk;
      cp[q + 5] = 0;
      const pc = Math.min(1, a.peaks[b] * 1.4) * 0.8;
      cc[q] = cc[q + 3] = pc;
      cc[q + 1] = cc[q + 4] = pc;
      cc[q + 2] = cc[q + 5] = pc;
    }
    bars.attributes.position.needsUpdate = true;
    bars.attributes.color.needsUpdate = true;
    caps.attributes.position.needsUpdate = true;
    caps.attributes.color.needsUpdate = true;

    // ---- history tunnel --------------------------------------------------------------
    const K = this.K;
    const speed = Math.max(0.05, p.num('speed'));
    this.timer += dt * speed;
    while (this.timer >= PUSH_INTERVAL) {
      this.timer -= PUSH_INTERVAL;
      this.head = (this.head + 1) % K;
      this.history.set(spec, this.head * DISPLAY_BANDS);
    }
    const frac = this.timer / PUSH_INTERVAL;
    const rg = this.rings.geometry;
    const rp = rg.attributes.position.array as Float32Array;
    const rc = rg.attributes.color.array as Float32Array;
    const dz = DZ * Math.max(0.3, p.num('depth'));
    for (let k = 0; k < K; k++) {
      const slot = ((this.head - k + K) % K) * DISPLAY_BANDS;
      const depth = k + frac;
      const z = -depth * dz * motion - 0.02;
      const alpha = Math.pow(Math.max(0, 1 - depth / K), 1.6) * 0.5;
      const ringBase = r0 * (1 + depth * 0.012);
      const t = k < 2 ? 0.6 : 0.15;
      this.tmp.copy(secondary).lerp(primary, t);
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const vi = this.history[slot + BAND[i]];
        const vj = this.history[slot + BAND[j]];
        const ri = ringBase + Math.pow(vi, 1.3) * MAXLEN[BAND[i]] * intensity * 0.6;
        const rj = ringBase + Math.pow(vj, 1.3) * MAXLEN[BAND[j]] * intensity * 0.6;
        const o = (k * N + i) * 6;
        rp[o] = COS[i] * ri;
        rp[o + 1] = SIN[i] * ri;
        rp[o + 2] = z;
        rp[o + 3] = COS[j] * rj;
        rp[o + 4] = SIN[j] * rj;
        rp[o + 5] = z;
        const w = alpha * (0.5 + 0.5 * Math.min(1, vi));
        const cr = this.tmp.r * w;
        const cg = this.tmp.g * w;
        const cb = this.tmp.b * w;
        rc[o] = rc[o + 3] = cr;
        rc[o + 1] = rc[o + 4] = cg;
        rc[o + 2] = rc[o + 5] = cb;
      }
    }
    rg.attributes.position.needsUpdate = true;
    rg.attributes.color.needsUpdate = true;

    // ---- oscilloscope ring -----------------------------------------------------------
    const sg = this.scope.geometry;
    const sp = sg.attributes.position.array as Float32Array;
    const sc = sg.attributes.color.array as Float32Array;
    const scopeR = r0 * 0.6;
    const amp = 0.28 * a.activity * intensity * motion;
    for (let i = 0; i < WAVE_POINTS; i++) {
      const j = (i + 1) % WAVE_POINTS;
      const a0 = (i / WAVE_POINTS) * Math.PI * 2;
      const a1 = (j / WAVE_POINTS) * Math.PI * 2;
      const q0 = scopeR + a.waveform[i] * amp;
      const q1 = scopeR + a.waveform[j] * amp;
      const o = i * 6;
      sp[o] = Math.cos(a0) * q0;
      sp[o + 1] = Math.sin(a0) * q0;
      sp[o + 2] = 0.01;
      sp[o + 3] = Math.cos(a1) * q1;
      sp[o + 4] = Math.sin(a1) * q1;
      sp[o + 5] = 0.01;
      const c = 0.22 + 0.4 * a.activity;
      sc[o] = sc[o + 3] = secondary.r * c;
      sc[o + 1] = sc[o + 4] = secondary.g * c;
      sc[o + 2] = sc[o + 5] = secondary.b * c;
    }
    sg.attributes.position.needsUpdate = true;
    sg.attributes.color.needsUpdate = true;

    // ---- snare shock ring ------------------------------------------------------------
    if (a.snareCount !== this.snareSeen) {
      const first = this.snareSeen < 0;
      this.snareSeen = a.snareCount;
      if (!first) {
        this.shockAge = 0;
        this.shockStrength = Math.min(1, a.snare + 0.4);
      }
    }
    this.shockAge += dt;
    const life = Math.max(0, 1 - this.shockAge / 0.55);
    this.shock.scale.setScalar(r0 + this.shockAge * 2.6 * motion);
    this.shockMat.opacity = life * life * this.shockStrength * 0.7 * (ctx.reducedMotion ? 0.4 : 1);
    this.shockMat.color.copy(primary);

    // ---- particles from the bands that sound -----------------------------------------
    const hatNew = a.hatCount !== this.hatSeen && this.hatSeen >= 0;
    this.hatSeen = a.hatCount;
    const P = this.P;
    if (a.playing && !ctx.reducedMotion) {
      this.emit += dt * a.treble * a.treble * 110 * p.num('density') * a.activity;
      if (hatNew) this.emit += 8 * Math.min(1, a.hat + 0.3) * p.num('density');
    }
    let bestBand = 60;
    let bestVal = 0;
    for (let b = 52; b < DISPLAY_BANDS; b++) {
      if (spec[b] > bestVal) {
        bestVal = spec[b];
        bestBand = b;
      }
    }
    const pg = this.particles.geometry;
    const pp = pg.attributes.position.array as Float32Array;
    const pc = pg.attributes.color.array as Float32Array;
    while (this.emit >= 1 && P > 0) {
      this.emit -= 1;
      const n = this.spawnCount++;
      const idx = this.next;
      this.next = (this.next + 1) % P;
      const jitterBand = Math.max(40, Math.min(DISPLAY_BANDS - 1, bestBand + Math.round((hash01(n) - 0.5) * 14)));
      const line = hash01(n * 3.1) < 0.5 ? jitterBand : N - 1 - jitterBand;
      const len = 0.025 + Math.pow(spec[jitterBand], 1.3) * MAXLEN[jitterBand] * intensity;
      const rr = r0 + len;
      pp[idx * 3] = COS[line] * rr;
      pp[idx * 3 + 1] = SIN[line] * rr;
      pp[idx * 3 + 2] = 0;
      const sp2 = 0.45 + 0.9 * hash01(n * 1.7);
      this.vel[idx * 3] = COS[line] * sp2;
      this.vel[idx * 3 + 1] = SIN[line] * sp2;
      this.vel[idx * 3 + 2] = (hash01(n * 5.3) - 0.5) * 0.4;
      this.maxLife[idx] = 0.5 + 0.8 * hash01(n * 2.9);
      this.life[idx] = this.maxLife[idx];
    }
    if (this.emit > 50) this.emit = 0;
    for (let i = 0; i < P; i++) {
      const lf = this.life[i];
      const o = i * 3;
      if (lf <= 0) {
        pc[o] = pc[o + 1] = pc[o + 2] = 0;
        continue;
      }
      this.life[i] = lf - dt;
      pp[o] += this.vel[o] * dt;
      pp[o + 1] += this.vel[o + 1] * dt;
      pp[o + 2] += this.vel[o + 2] * dt;
      const k = Math.max(0, lf / this.maxLife[i]);
      const w = hash01(i) < 0.35 ? 1 : 0;
      pc[o] = (primary.r + (1 - primary.r) * w) * k;
      pc[o + 1] = (primary.g + (1 - primary.g) * w) * k;
      pc[o + 2] = (primary.b + (1 - primary.b) * w) * k;
    }
    pg.attributes.position.needsUpdate = true;
    pg.attributes.color.needsUpdate = true;
    (this.particles.material as THREE.PointsMaterial).size = 2.4 * (ctx.height / 900);

    // ---- motion ----------------------------------------------------------------------
    this.spin += dt * 0.05 * p.num('rotation') * motion * directionSign(p.str('direction'));
    const px = ctx.exporting || ctx.reducedMotion ? 0 : ctx.pointer.x;
    const py = ctx.exporting || ctx.reducedMotion ? 0 : ctx.pointer.y;
    this.tiltX += (py * 0.2 - this.tiltX) * Math.min(1, dt * 2.5);
    this.tiltY += (px * 0.28 - this.tiltY) * Math.min(1, dt * 2.5);
    this.group.scale.setScalar(scale);
    this.group.rotation.set(0.38 - this.tiltX, -0.3 + this.tiltY, this.spin);
    this.telemetry.rotation = wrapDegrees((this.spin * 180) / Math.PI);
    this.telemetry.tilt = ((0.38 - this.tiltX) * 180) / Math.PI;

    applyCamera(ctx, { fitRadius: 2.05 * scale, fov: 35, target: TARGET.set(0, 0, -0.8 * scale) });
  }

  dispose(): void {
    disposeTree(this.root);
  }
}

const TARGET = new THREE.Vector3();

export const create: SceneFactory = (env) => new RadialSpectrumScene(env);
