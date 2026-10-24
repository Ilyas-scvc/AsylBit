/**
 * SCENE 03 — WAVE FIELD (ported from the v1 R3F mode; defaults reproduce the original)
 *
 * Ridge lines in 3D; each row is a snapshot of the music scrolling away from the viewer.
 *   x → frequency (mirrored, lows in the middle) · bass → broad swells (+ travelling kick
 *   wave) · mids → bend the rows · treble → small fast ripples · camera drifts slowly
 */
import * as THREE from 'three';
import { DISPLAY_BANDS } from '../../audio/analysis/frame';
import { effectiveFov } from '../camera';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { directionSign, disposeTree, wrapDegrees } from './common';
import { gradientColor } from '../colors';

const WIDTH = 9;
const DEPTH = 11;
const PUSH_INTERVAL = 1 / 32;
const ROW_SCALARS = 4;
const DEG = Math.PI / 180;

class WaveFieldScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly lines: THREE.LineSegments;
  private ROWS = 0;
  private COLS = 0;
  private columnBands = new Float32Array(0);
  private spec = new Float32Array(0);
  private scalars = new Float32Array(0);
  private head = 0;
  private timer = 0;
  private phase = 0;
  private drift = 0;
  private tiltX = 0;
  private tiltY = 0;
  private readonly look = new THREE.Vector3();
  private readonly off = new THREE.Vector3();
  private readonly tmp = new THREE.Color();
  private readonly baseRows: number;
  private readonly baseCols: number;

  constructor(env: SceneEnv) {
    this.baseRows = env.quality.detail === 'high' ? 60 : 36;
    this.baseCols = env.quality.detail === 'high' ? 150 : 90;
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.root.add(this.lines);
  }

  private build(rows: number, cols: number): void {
    this.ROWS = rows;
    this.COLS = cols;
    const crossEvery = this.baseRows > 40 ? 10 : 9;
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(rows * cols * 3), 3);
    const col = new THREE.BufferAttribute(new Float32Array(rows * cols * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('color', col);
    const index: number[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) index.push(r * cols + c, r * cols + c + 1);
    for (let c = 0; c < cols; c += crossEvery) for (let r = 0; r < rows - 1; r++) index.push(r * cols + c, (r + 1) * cols + c);
    const last = cols - 1;
    if (last % crossEvery !== 0) for (let r = 0; r < rows - 1; r++) index.push(r * cols + last, (r + 1) * cols + last);
    g.setIndex(index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -DEPTH / 2), 16);
    this.lines.geometry.dispose();
    this.lines.geometry = g;
    this.columnBands = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      const x = (c / (cols - 1)) * 2 - 1;
      this.columnBands[c] = Math.pow(Math.abs(x), 0.85) * (DISPLAY_BANDS - 1);
    }
    this.spec = new Float32Array(rows * DISPLAY_BANDS);
    this.scalars = new Float32Array(rows * ROW_SCALARS);
    this.head = 0;
  }

  update(ctx: SceneFrameContext): void {
    const p = ctx.params;
    const a = ctx.audio;
    const dt = ctx.dt;
    const motion = ctx.reducedMotion ? 0.45 : 1;
    const intensity = p.num('motionIntensity');
    const act = a.activity;
    const density = p.num('density') / 0.6;
    const rows = Math.max(12, Math.round(this.baseRows * Math.min(1.6, density)));
    const cols = Math.max(24, Math.round(this.baseCols * Math.min(1.6, density)));
    if (rows !== this.ROWS || cols !== this.COLS) this.build(rows, cols);
    const ROWS = this.ROWS;
    const COLS = this.COLS;
    const speed = Math.max(0.05, p.num('speed'));
    const deform = p.num('deformation');
    const width = WIDTH * p.num('scale');
    const depthLen = DEPTH * Math.max(0.2, p.num('depth'));

    this.phase += dt * (0.5 + 1.2 * a.mids * act) * motion * speed;
    this.drift += dt * 0.06 * p.num('rotation') * motion * directionSign(p.str('direction'));

    this.timer += dt * motion * speed;
    while (this.timer >= PUSH_INTERVAL) {
      this.timer -= PUSH_INTERVAL;
      this.head = (this.head + 1) % ROWS;
      this.spec.set(a.spectrum, this.head * DISPLAY_BANDS);
      const o = this.head * ROW_SCALARS;
      this.scalars[o] = a.bass;
      this.scalars[o + 1] = a.mids;
      this.scalars[o + 2] = a.treble;
      this.scalars[o + 3] = a.kick;
    }
    const frac = this.timer / PUSH_INTERVAL;

    const g = this.lines.geometry;
    const pos = g.attributes.position.array as Float32Array;
    const col = g.attributes.color.array as Float32Array;
    const rowStep = depthLen / (ROWS - 1);
    const idle = 1 - act;
    const primary = ctx.palette.primary;
    const secondary = ctx.palette.secondary;
    const mode = ctx.palette.gradient;
    for (let r = 0; r < ROWS; r++) {
      const slot = (this.head - r + ROWS) % ROWS;
      const so = slot * DISPLAY_BANDS;
      const sc = slot * ROW_SCALARS;
      const bass = this.scalars[sc] * intensity;
      const mid = this.scalars[sc + 1] * intensity;
      const high = this.scalars[sc + 2] * intensity;
      const kick = this.scalars[sc + 3];
      const depth = r + frac;
      const z = 1.3 - depth * rowStep;
      const fadeDepth = Math.pow(Math.max(0, 1 - depth / ROWS), 1.25);
      const warp = mid * 0.32 * Math.sin(z * 0.9 + this.phase * 0.7) * motion;
      for (let c = 0; c < COLS; c++) {
        const x01 = (c / (COLS - 1)) * 2 - 1;
        const bf = this.columnBands[c];
        const b0 = Math.floor(bf);
        const b1 = Math.min(DISPLAY_BANDS - 1, b0 + 1);
        const t = bf - b0;
        const v = this.spec[so + b0] * (1 - t) + this.spec[so + b1] * t;
        const ax = Math.abs(x01);
        let y = Math.pow(v, 1.35) * (1.25 - 0.85 * ax) * 1.1;
        y += (bass * 0.42 + kick * 0.38) * Math.exp(-x01 * x01 * 2.2) * motion;
        y += high * 0.05 * Math.sin(x01 * 46 + this.phase * 7 + r * 0.6) * (0.4 + ax) * motion;
        y *= deform;
        y += idle * 0.07 * Math.sin(x01 * 2.4 + this.phase * 0.5 + z * 0.55) * Math.cos(z * 0.9 - this.phase * 0.35);
        const o = (r * COLS + c) * 3;
        pos[o] = x01 * (width / 2) + warp * (1 - ax * 0.5);
        pos[o + 1] = y * intensity * 0.82 - 1.0;
        pos[o + 2] = z;
        const lift = Math.min(1, y * 1.3);
        const front = r < 3 ? (1 - r / 3) * 0.45 : 0;
        const tint = Math.min(1, lift * 0.75 + kick * 0.5 + front * lift);
        const bright = (0.16 + 0.84 * Math.min(1, 0.3 + lift)) * fadeDepth;
        gradientColor(mode, ax, tint, primary, secondary, this.tmp);
        col[o] = this.tmp.r * bright;
        col[o + 1] = this.tmp.g * bright;
        col[o + 2] = this.tmp.b * bright;
      }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;

    // ---- slow camera drift, framed for portrait and landscape --------------------------
    const cam = ctx.camera;
    const px = ctx.exporting || ctx.reducedMotion ? 0 : ctx.pointer.x;
    const py = ctx.exporting || ctx.reducedMotion ? 0 : ctx.pointer.y;
    this.tiltX += (px * 0.6 - this.tiltX) * Math.min(1, dt * 1.5);
    this.tiltY += (py * 0.3 - this.tiltY) * Math.min(1, dt * 1.5);
    const portrait = Math.min(1, Math.max(0, (1.2 - ctx.aspect) / 0.65));
    this.look.set(Math.sin(this.drift * 0.8) * 0.4, -0.2 - portrait * 0.6, -2.8 - portrait * 0.6);
    this.off.set(
      Math.sin(this.drift) * 1.4 + this.tiltX,
      1.55 + portrait * 2.6 + Math.sin(this.drift * 0.71) * 0.25 + this.tiltY,
      5.2 + portrait * 3.2 + Math.cos(this.drift * 0.53) * 0.35,
    ).sub(this.look);
    const fov = p.num('fov');
    const effFov = effectiveFov(fov, p.num('perspective'));
    // keep the framing when the field of view changes (dolly zoom), then apply zoom / distance
    const keep = Math.tan((35 * DEG) / 2) / Math.tan((effFov * DEG) / 2);
    this.off.multiplyScalar((keep * p.num('distance')) / Math.max(0.05, p.num('zoom')));
    this.off.applyAxisAngle(Y_AXIS, (p.num('cameraRotation') + p.num('autoOrbit') * ctx.clock) * DEG);
    cam.fov = effFov;
    cam.position.copy(this.look).add(this.off);
    cam.near = 0.05;
    cam.far = 200;
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    cam.updateProjectionMatrix();
    this.telemetry.rotation = wrapDegrees((Math.atan2(cam.position.x - this.look.x, cam.position.z - this.look.z) * 180) / Math.PI);
    this.telemetry.tilt = (Math.atan2(cam.position.y - this.look.y, Math.hypot(cam.position.x - this.look.x, cam.position.z - this.look.z)) * 180) / Math.PI;
  }

  dispose(): void {
    disposeTree(this.root);
  }
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export const create: SceneFactory = (env) => new WaveFieldScene(env);
