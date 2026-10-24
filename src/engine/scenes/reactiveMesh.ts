/**
 * SCENE 04 — REACTIVE MESH
 *
 * A dense wireframe (and optional dot) grid whose relief is computed entirely on the GPU.
 * The grid itself is static; a small R8 texture holds a scrolling history of the spectrum
 * ("waterfall"), and the vertex shader combines it with travelling waves:
 *
 *   bass   → broad circular swells travelling outward (moving peaks)
 *   kick   → an expanding ring wave from the centre
 *   mids   → local wave interference across the surface
 *   treble → fine, fast surface detail
 *
 * Layouts: FLAT sheet, SPIRAL (polar grid wound into arms) and BOWL (bent sheet).
 */
import * as THREE from 'three';
import { DISPLAY_BANDS } from '../../audio/analysis/frame';
import { applyCamera } from '../camera';
import { GLSL_GRADIENT } from '../colors';
import type { SceneEnv, SceneFrameContext, SceneFactory, SceneInstance } from '../types';
import { SIMPLEX_NOISE_3D, directionSign, disposeTree, wrapDegrees } from './common';

const HISTORY = 64;
const PUSH_INTERVAL = 1 / 30;

const VERT = /* glsl */ `
uniform sampler2D uHistory;
uniform float uHead;
uniform float uFrac;
uniform float uLayout;
uniform float uTurns;
uniform float uSize;
uniform float uRelief;
uniform float uDeform;
uniform float uComplexity;
uniform float uPhase;
uniform float uBass;
uniform float uMids;
uniform float uTreble;
uniform float uKickAge;
uniform float uKickAmp;
uniform float uIdle;
uniform float uPointScale;
uniform float uDotSize;
varying float vHeight;
varying float vFreq;
varying float vEdge;
varying float vDepth;
${SIMPLEX_NOISE_3D}

float spectrumAt(float freq, float age) {
  // continuous "now" is uHead + uFrac rows; sampling one row behind it keeps the scroll
  // seamless when a new row is pushed (uHead+1, uFrac→0)
  float row = mod(uHead + uFrac - 1.0 - age * ${HISTORY - 2}.0 + ${HISTORY}.0, ${HISTORY}.0);
  return texture2D(uHistory, vec2(freq, (row + 0.5) / ${HISTORY}.0)).r * 1.3;
}

void main() {
  vec2 uv = position.xy; // 0..1 grid coordinates
  vec3 p;
  float freq;
  float age;
  float radial;
  if (uLayout < 0.5) {
    // FLAT: x across, z into depth; lows in the middle, the waterfall scrolls away
    p = vec3((uv.x - 0.5) * 2.0, 0.0, (0.5 - uv.y) * 2.0) * uSize;
    freq = abs(uv.x * 2.0 - 1.0);
    age = uv.y;
    radial = length(p.xz) / uSize;
  } else if (uLayout < 1.5) {
    // SPIRAL: polar grid, arms wound by uTurns; frequency runs around, time runs outward
    float r = mix(0.12, 1.0, uv.y);
    float a = uv.x * 6.28318530718 + uv.y * uTurns * 6.28318530718;
    p = vec3(cos(a) * r, 0.0, sin(a) * r) * uSize;
    freq = 0.5 - 0.5 * cos(uv.x * 6.28318530718);
    age = uv.y;
    radial = r;
  } else {
    // BOWL: the flat sheet bent upward toward its edges
    vec2 c = (uv - 0.5) * 2.0;
    p = vec3(c.x, 0.0, -c.y) * uSize;
    p.y = dot(c, c) * 0.55 * uSize;
    freq = clamp(length(c) / 1.4142, 0.0, 1.0);
    age = 0.0;
    radial = length(c) / 1.4142;
  }
  float spec = spectrumAt(freq, age);
  float relief = pow(spec, 1.3) * (1.15 - 0.6 * freq);
  // bass: circular swells travelling outward
  relief += uBass * 0.55 * sin(radial * 7.0 - uPhase * 2.2) * (1.0 - radial * 0.5);
  // kick: an expanding ring
  float ring = exp(-pow((radial - uKickAge * 0.9) * 7.0, 2.0)) * uKickAmp * (1.0 - smoothstep(0.6, 1.2, uKickAge));
  relief += ring * 0.9;
  // mids: local interference
  float n = snoise(vec3(p.xz * (1.4 + uComplexity * 2.0) / uSize, uPhase * 0.6));
  relief += n * uMids * 0.35;
  // treble: fine detail
  float f = snoise(vec3(p.xz * (6.0 + uComplexity * 10.0) / uSize, uPhase * 2.4));
  relief += f * uTreble * 0.09;
  // idle breathing so the mesh is alive before any audio
  relief += uIdle * 0.08 * sin(radial * 5.0 - uPhase * 0.8);
  relief *= uDeform;
  p.y += relief * uRelief * uSize * 0.42;

  vHeight = relief;
  vFreq = freq;
  vEdge = radial;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uDotSize * uPointScale * (0.8 + clamp(relief, 0.0, 1.5)) * (4.5 / max(1.0, vDepth));
}
`;

const FRAG = /* glsl */ `
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform float uGradient;
uniform float uIntensity;
uniform float uFar;
uniform float uIsPoint;
varying float vHeight;
varying float vFreq;
varying float vEdge;
varying float vDepth;
${GLSL_GRADIENT}
void main() {
  if (uIsPoint > 0.5) {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
  }
  float level = clamp(vHeight * 0.9, 0.0, 1.0);
  vec3 col = bfGradient(uGradient, vFreq, level, uPrimary, uSecondary);
  float edge = 1.0 - smoothstep(0.75, 1.05, vEdge);
  float fog = 1.0 - smoothstep(uFar * 0.45, uFar, vDepth);
  float a = (0.18 + 0.82 * level) * edge * fog * uIntensity;
  gl_FragColor = vec4(col * a, 1.0);
}
`;

const LAYOUTS = { flat: 0, spiral: 1, bowl: 2 } as const;

class ReactiveMeshScene implements SceneInstance {
  readonly root = new THREE.Group();
  telemetry = { rotation: 0, tilt: 0 };
  private readonly data = new Uint8Array(DISPLAY_BANDS * HISTORY);
  private readonly history: THREE.DataTexture;
  private readonly lineMat: THREE.ShaderMaterial;
  private readonly dotMat: THREE.ShaderMaterial;
  private readonly lines: THREE.LineSegments;
  private readonly dots: THREE.Points;
  private gridN = 0;
  private gridStep = 0;
  private head = 0;
  private timer = 0;
  private phase = 0;
  private spin = 0;
  private kickSeen = -1;
  private kickAge = 9;
  private kickAmp = 0;
  private readonly maxN: number;

  constructor(env: SceneEnv) {
    this.maxN = env.quality.detail === 'high' ? 230 : 150;
    this.history = new THREE.DataTexture(this.data, DISPLAY_BANDS, HISTORY, THREE.RedFormat, THREE.UnsignedByteType);
    this.history.magFilter = THREE.LinearFilter;
    this.history.minFilter = THREE.LinearFilter;
    this.history.wrapS = THREE.ClampToEdgeWrapping;
    this.history.wrapT = THREE.RepeatWrapping;
    this.history.needsUpdate = true;
    const uniforms = () => ({
      uHistory: { value: this.history },
      uHead: { value: 0 },
      uFrac: { value: 0 },
      uLayout: { value: 0 },
      uTurns: { value: 1 },
      uSize: { value: 3 },
      uRelief: { value: 1 },
      uDeform: { value: 1 },
      uComplexity: { value: 0.5 },
      uPhase: { value: 0 },
      uBass: { value: 0 },
      uMids: { value: 0 },
      uTreble: { value: 0 },
      uKickAge: { value: 9 },
      uKickAmp: { value: 0 },
      uIdle: { value: 1 },
      uPointScale: { value: 1 },
      uDotSize: { value: 2 },
      uPrimary: { value: new THREE.Color() },
      uSecondary: { value: new THREE.Color() },
      uGradient: { value: 1 },
      uIntensity: { value: 1 },
      uFar: { value: 20 },
      uIsPoint: { value: 0 },
    });
    const common = { vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
    this.lineMat = new THREE.ShaderMaterial({ ...common, uniforms: uniforms() });
    this.dotMat = new THREE.ShaderMaterial({ ...common, uniforms: { ...uniforms(), uIsPoint: { value: 1 } } });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMat);
    this.dots = new THREE.Points(new THREE.BufferGeometry(), this.dotMat);
    this.lines.frustumCulled = false;
    this.dots.frustumCulled = false;
    this.root.add(this.lines, this.dots);
  }

  /** Static grid: positions are (u, v) in 0..1; the shader does everything else. */
  private build(n: number, lineStep: number): void {
    this.gridN = n;
    this.gridStep = lineStep;
    const pos = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 3;
        pos[o] = i / (n - 1);
        pos[o + 1] = j / (n - 1);
      }
    }
    const index: number[] = [];
    for (let j = 0; j < n; j += lineStep) for (let i = 0; i < n - 1; i++) index.push(j * n + i, j * n + i + 1);
    for (let i = 0; i < n; i += lineStep) for (let j = 0; j < n - 1; j++) index.push(j * n + i, (j + 1) * n + i);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lineGeo.setIndex(index);
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.lines.geometry.dispose();
    this.dots.geometry.dispose();
    this.lines.geometry = lineGeo;
    this.dots.geometry = dotGeo;
  }

  update(ctx: SceneFrameContext): void {
    const p = ctx.params;
    const a = ctx.audio;
    const dt = ctx.dt;
    const motion = ctx.reducedMotion ? 0.45 : 1;
    const intensity = p.num('motionIntensity');
    const speed = p.num('speed');

    // the size that is built is the size that is compared — otherwise a capped grid rebuilds every frame
    const wanted = Math.round(24 + p.num('density') * (this.maxN - 24) * Math.min(1.4, ctx.quality.particles + 0.4));
    const n = Math.min(this.maxN + 40, Math.max(24, wanted));
    const lineStep = Math.max(1, Math.round(1 + (1 - p.num('lineDensity')) * 5));
    if (n !== this.gridN || lineStep !== this.gridStep) this.build(n, lineStep);

    // waterfall history: one spectrum row every 1/30 s of (speed-scaled) time
    this.timer += dt * Math.max(0.05, speed);
    while (this.timer >= PUSH_INTERVAL) {
      this.timer -= PUSH_INTERVAL;
      this.head = (this.head + 1) % HISTORY;
      const row = this.head * DISPLAY_BANDS;
      for (let b = 0; b < DISPLAY_BANDS; b++) this.data[row + b] = Math.min(255, Math.round((a.spectrum[b] / 1.3) * 255));
      this.history.needsUpdate = true;
    }

    if (a.kickCount !== this.kickSeen) {
      const first = this.kickSeen < 0;
      this.kickSeen = a.kickCount;
      if (!first) {
        this.kickAge = 0;
        this.kickAmp = Math.min(1.2, a.kick + 0.3);
      }
    }
    this.kickAge += dt * Math.max(0.2, speed);

    this.phase += dt * (0.6 + 0.9 * a.mids * a.activity) * motion * speed * directionSign(p.str('direction'));
    this.spin += dt * 0.05 * p.num('rotation') * motion * directionSign(p.str('direction'));

    const size = 3 * p.num('scale');
    const layout = LAYOUTS[p.str('layout') as keyof typeof LAYOUTS] ?? 0;
    for (const mat of [this.lineMat, this.dotMat]) {
      const u = mat.uniforms;
      u.uHead.value = this.head;
      u.uFrac.value = this.timer / PUSH_INTERVAL;
      u.uLayout.value = layout;
      u.uTurns.value = p.num('spiralTurns');
      u.uSize.value = size;
      u.uRelief.value = p.num('depth');
      u.uDeform.value = p.num('deformation');
      u.uComplexity.value = p.num('complexity');
      u.uPhase.value = this.phase;
      u.uBass.value = a.bass * intensity * motion;
      u.uMids.value = a.mids * intensity * motion;
      u.uTreble.value = a.treble * intensity * motion;
      u.uKickAge.value = this.kickAge;
      u.uKickAmp.value = this.kickAmp * motion;
      u.uIdle.value = 1 - a.activity;
      u.uPointScale.value = ctx.height / 900;
      u.uDotSize.value = 2.2 * p.num('dotSize');
      (u.uPrimary.value as THREE.Color).copy(ctx.palette.primary);
      (u.uSecondary.value as THREE.Color).copy(ctx.palette.secondary);
      u.uGradient.value = ctx.palette.gradient;
      u.uFar.value = size * 5;
    }
    this.lineMat.uniforms.uIntensity.value = p.num('lines');
    this.dotMat.uniforms.uIntensity.value = p.num('dots');
    this.lines.visible = p.num('lines') > 0.001;
    this.dots.visible = p.num('dots') > 0.001;
    this.root.rotation.y = this.spin;

    const tilt = p.num('tilt');
    const cam = applyCamera(ctx, { fitRadius: size * 1.05, elevation: tilt, fov: 45, parallax: 0.6, margin: 1.0 });
    this.telemetry.rotation = wrapDegrees(cam.azimuth + (this.spin * 180) / Math.PI);
    this.telemetry.tilt = cam.elevation;
  }

  dispose(): void {
    disposeTree(this.root);
    this.history.dispose();
  }
}

export const create: SceneFactory = (env) => new ReactiveMeshScene(env);
