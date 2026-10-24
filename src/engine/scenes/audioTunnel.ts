/**
 * SCENE 07 — INFINITE AUDIO TUNNEL
 *
 * The camera flies into an endless tunnel of glowing rings joined by `symmetry` spokes.
 * Rings are recycled as they pass the camera, so the tunnel never ends and memory is flat.
 *
 *   bass + kick → travel thrust, integrated through a spring: speed changes are smooth,
 *                 the camera never jumps
 *   pulses      → bass / kick energy travels from the camera into the depth via a short
 *                 history buffer, lighting rings in sequence
 *   spectrum    → ring outlines bulge with the spectrum (strongest near the camera)
 *   distortion  → the tunnel axis bends and twists gently over depth
 */
import * as THREE from 'three';
import { DISPLAY_BANDS } from '../../audio/analysis/frame';
import { Spring } from '../../audio/dsp/envelope';
import { zoomedFov } from '../camera';
import { gradientColor } from '../colors';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { directionSign, disposeTree, wrapDegrees } from './common';

const PULSE_HISTORY = 240;
const DEG = Math.PI / 180;

class AudioTunnelScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly lines: THREE.LineSegments;
  private rings = 0;
  private sides = 0;
  private perRing = 0;
  private travel = 0;
  private spin = 0;
  private sway = 0;
  private readonly thrust = new Spring(0, 60, 14);
  private readonly pulseHist = new Float32Array(PULSE_HISTORY);
  private pulseHead = 0;
  private pulseTimer = 0;
  private kickSeen = -1;
  private kickHold = 0;
  private readonly tmp = new THREE.Color();
  private readonly baseRings: number;

  constructor(env: SceneEnv) {
    this.baseRings = env.quality.detail === 'high' ? 56 : 36;
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.lines.frustumCulled = false;
    this.root.add(this.lines);
  }

  private build(rings: number, sides: number): void {
    this.rings = rings;
    this.sides = sides;
    // polygon sides are subdivided so the outline can follow the spectrum
    this.perRing = sides >= 16 ? 96 : sides * Math.max(4, Math.round(64 / sides));
    const ringSegs = rings * this.perRing;
    const spokeSegs = (rings - 1) * sides;
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array((ringSegs + spokeSegs) * 2 * 3), 3);
    const col = new THREE.BufferAttribute(new Float32Array((ringSegs + spokeSegs) * 2 * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('color', col);
    this.lines.geometry.dispose();
    this.lines.geometry = g;
  }

  /** Pulse energy that was emitted `age` seconds ago (linear interpolation). */
  private pulseAt(age: number): number {
    const f = age / (1 / 60);
    const i = Math.floor(f);
    if (i >= PULSE_HISTORY - 1) return 0;
    const t = f - i;
    const a = this.pulseHist[(this.pulseHead - i + PULSE_HISTORY) % PULSE_HISTORY];
    const b = this.pulseHist[(this.pulseHead - i - 1 + PULSE_HISTORY) % PULSE_HISTORY];
    return a * (1 - t) + b * t;
  }

  update(ctx: SceneFrameContext): void {
    const p = ctx.params;
    const a = ctx.audio;
    const dt = ctx.dt;
    const motion = ctx.reducedMotion ? 0.4 : 1;
    const intensity = p.num('motionIntensity');
    const sides = Math.max(3, Math.min(16, Math.round(p.num('symmetry'))));
    const rings = Math.max(12, Math.round(this.baseRings * Math.min(1.5, p.num('density') / 0.6) * Math.min(1.3, ctx.quality.particles + 0.4)));
    if (rings !== this.rings || sides !== this.sides) this.build(rings, sides);

    if (a.kickCount !== this.kickSeen) {
      const first = this.kickSeen < 0;
      this.kickSeen = a.kickCount;
      if (!first) this.kickHold = Math.min(1, a.kick + 0.25);
    }
    this.kickHold = Math.max(0, this.kickHold - dt * 4);

    // ---- travel: smooth thrust from bass and kicks -----------------------------------
    const dir = directionSign(p.str('direction'));
    const thrust = this.thrust.step((a.bass * 0.9 + this.kickHold * 1.6) * intensity * motion, dt);
    const speed = (0.9 + thrust * 2.2) * p.num('speed') * motion;
    this.travel += dt * speed * dir;
    this.spin += dt * 0.12 * p.num('rotation') * motion * dir;
    this.sway += dt * 0.15 * motion;

    // pulse history at a fixed 60 Hz grid, so the inward travel is frame-rate independent
    this.pulseTimer += dt;
    while (this.pulseTimer >= 1 / 60) {
      this.pulseTimer -= 1 / 60;
      this.pulseHead = (this.pulseHead + 1) % PULSE_HISTORY;
      this.pulseHist[this.pulseHead] = Math.min(1.5, (a.bass * 0.6 + a.kick * 0.9) * intensity);
    }

    const scale = p.num('scale');
    const radius = 1.0 * scale;
    const spacing = 0.55 * Math.max(0.25, p.num('depth'));
    const length = rings * spacing;
    const warp = p.num('deformation') * 0.6 * motion;
    const twist = p.num('complexity') * 0.35;
    const offset = ((this.travel % spacing) + spacing) % spacing;
    const primary = ctx.palette.primary;
    const secondary = ctx.palette.secondary;
    const mode = ctx.palette.gradient;
    const g = this.lines.geometry;
    const pos = g.attributes.position.array as Float32Array;
    const col = g.attributes.color.array as Float32Array;
    const per = this.perRing;
    const spec = a.spectrum;

    // pre-compute ring centres and frame data
    const cx = RING_CX.length >= rings ? RING_CX : (RING_CX = new Float32Array(rings * 2));
    const cy = RING_CY.length >= rings ? RING_CY : (RING_CY = new Float32Array(rings * 2));
    const cz = RING_CZ.length >= rings ? RING_CZ : (RING_CZ = new Float32Array(rings * 2));
    for (let i = 0; i < rings; i++) {
      const z = -(i * spacing - offset) - 0.2;
      const depthT = -z / length;
      cx[i] = Math.sin(z * 0.11 + this.sway * 1.3) * warp * depthT * 2.2;
      cy[i] = Math.cos(z * 0.09 + this.sway) * warp * depthT * 1.6;
      cz[i] = z;
    }

    let v = 0;
    const put = (x: number, y: number, z: number, c: THREE.Color, w: number) => {
      pos[v * 3] = x;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = z;
      col[v * 3] = c.r * w;
      col[v * 3 + 1] = c.g * w;
      col[v * 3 + 2] = c.b * w;
      v++;
    };
    const vx = VX.length >= per + 1 ? VX : (VX = new Float32Array((per + 1) * 2));
    const vy = VY.length >= per + 1 ? VY : (VY = new Float32Array((per + 1) * 2));
    const prevX = PX.length >= sides ? PX : (PX = new Float32Array(32));
    const prevY = PY.length >= sides ? PY : (PY = new Float32Array(32));
    for (let i = 0; i < rings; i++) {
      const z = cz[i];
      const depthT = Math.min(1, -z / length);
      const fog = Math.pow(1 - depthT, 1.4) * Math.min(1, (-z - 0.1) * 2.5);
      const pulse = this.pulseAt(depthT * 2.4);
      const near = 1 - depthT;
      const ringRot = this.spin + z * twist;
      for (let j = 0; j <= per; j++) {
        const t = j / per;
        const theta = t * Math.PI * 2 + ringRot;
        // polygon outline with `sides` corners
        const seg = (Math.PI * 2) / sides;
        const local = ((((theta - ringRot) % seg) + seg) % seg) - seg / 2;
        const poly = sides >= 16 ? 1 : Math.cos(seg / 2) / Math.cos(local);
        // radial symmetry: the spectrum is mirrored inside every segment
        const fold = Math.abs(local / (seg / 2));
        const band = Math.min(DISPLAY_BANDS - 1, Math.floor(fold * 0.8 * (DISPLAY_BANDS - 1)));
        const r = radius * poly * (1 + spec[band] * 0.35 * near * intensity + pulse * 0.12);
        vx[j] = cx[i] + Math.cos(theta) * r;
        vy[j] = cy[i] + Math.sin(theta) * r;
      }
      const level = Math.min(1, pulse * 0.8 + 0.15);
      gradientColor(mode, depthT, level, primary, secondary, this.tmp);
      const w = fog * (0.25 + 0.95 * level);
      for (let j = 0; j < per; j++) {
        put(vx[j], vy[j], z, this.tmp, w);
        put(vx[j + 1], vy[j + 1], z, this.tmp, w);
      }
      // spokes to the previous ring (corners only → radial symmetry lines)
      for (let s = 0; s < sides; s++) {
        const j = Math.round((s / sides) * per);
        const x = vx[j];
        const y = vy[j];
        if (i > 0) {
          put(prevX[s], prevY[s], cz[i - 1], this.tmp, w * 0.55);
          put(x, y, z, this.tmp, w * 0.55);
        }
        prevX[s] = x;
        prevY[s] = y;
      }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.setDrawRange(0, v);

    // ---- camera: inside the tunnel, looking along its axis -----------------------------
    const cam = ctx.camera;
    const roll = (p.num('cameraRotation') + p.num('autoOrbit') * ctx.clock) * DEG + Math.sin(this.sway * 0.7) * 0.05 * motion;
    // ZOOM magnifies like a lens (tan scaling) — dividing the angle could reach 180° and flip the image
    cam.fov = zoomedFov(p.num('fov'), p.num('zoom'));
    cam.near = 0.05;
    cam.far = length + 10;
    cam.position.set(0, 0, 0.6);
    cam.up.set(Math.sin(roll), Math.cos(roll), 0);
    const lookIndex = Math.min(rings - 1, 6);
    cam.lookAt(cx[lookIndex] * 0.5, cy[lookIndex] * 0.5, cz[lookIndex]);
    cam.updateProjectionMatrix();
    this.telemetry.rotation = wrapDegrees((roll * 180) / Math.PI);
    this.telemetry.tilt = 0;
  }

  dispose(): void {
    disposeTree(this.root);
  }
}

let RING_CX = new Float32Array(0);
let RING_CY = new Float32Array(0);
let RING_CZ = new Float32Array(0);
let VX = new Float32Array(0);
let VY = new Float32Array(0);
let PX = new Float32Array(0);
let PY = new Float32Array(0);

export const create: SceneFactory = (env) => new AudioTunnelScene(env);
