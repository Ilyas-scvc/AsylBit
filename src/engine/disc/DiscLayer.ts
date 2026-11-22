/**
 * DiscLayer — the spinning compact disc, drawn by the engine on SCENE 10 and, when enabled,
 * over any other scene. It has its own small three.js scene and camera (scenes move the shared
 * camera; the disc must not). It is drawn on top of the scene's effects — a heavy bloom, trails
 * or a kaleidoscope never burn out, smear or duplicate it; its glow is its own — and under the
 * colour grade, so it fades in and is graded together with the scene.
 *
 *   bass   → a small scale pulse (≤ ~4 %, spring-smoothed — the disc never wobbles)
 *   kick   → a short rim glow / flash (fast attack, ~0.2 s release)
 *   mids   → reflection energy: the light streak widens, the rainbow drifts
 *   treble → sparkle glints on the surface
 *   level  → up to +35 % spin speed, eased over ~1 s, so the spin never jerks
 *
 * One fragment shader draws the disc face: hole, clear inner ring, hub with the stacking ring,
 * data area and outer edge, in five styles, plus the user's artwork (full disc / centre label
 * / disc print) with fit, scale, offset, rotation and colour adjustments. Reflections are
 * computed in the disc's unspun frame, so — as on a real CD — the light streak stays put
 * while the surface (tracks, artwork, glints) spins under it.
 *
 * Like the scenes it reads no clock of its own: everything follows dt / clock / audio, so an
 * export reproduces the same frames.
 */
import * as THREE from 'three';
import { attackRelease, Spring } from '../../audio/dsp/envelope';
import type { ParamValues, Palette, SceneAudio } from '../types';
import { artworkFit, CASE_SIZE, discPlacement, type DiscArtwork } from './settings';

const STYLE_INDEX: Record<string, number> = { classic: 0, dark: 1, holo: 2, matte: 3, neon: 4 };
const MODE_INDEX: Record<string, number> = { full: 0, label: 1, print: 2 };
/** turns per second at ROTATION SPEED 1 */
const BASE_TURNS = 0.4;
const FOV = 28;
const CAMERA_Z = 8;
/** disc thickness (1.2 mm on a 120 mm disc) in radii */
const THICKNESS = 0.02;

const DISC_VERT = /* glsl */ `
varying vec2 vP;
varying float vFacing;
void main() {
  vP = position.xy;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  vFacing = abs(dot(n, normalize(cameraPosition - world.xyz)));
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const DISC_FRAG = /* glsl */ `
uniform float uSpin;
uniform float uStyle;
uniform float uHole;
uniform float uRing;
uniform float uReflect;
uniform float uRim;
uniform float uKick;
uniform float uMids;
uniform float uTreble;
uniform float uEnergy;
uniform float uClock;
uniform vec2 uLight;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform sampler2D uArt;
uniform float uHasArt;
uniform float uArtMode;
uniform vec4 uArtXf;
uniform float uArtRot;
uniform vec4 uArtAdj;
varying vec2 vP;
varying float vFacing;

vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float band(float r, float a, float b, float aa) { return smoothstep(a - aa, a + aa, r) * (1.0 - smoothstep(b - aa, b + aa, r)); }

// artwork at disc-surface point q (disc units); alpha = coverage × opacity
vec4 artAt(vec2 q) {
  vec2 p = rot2(uArtRot) * q - uArtXf.zw;
  vec2 uv = 0.5 + 0.5 * p * uArtXf.xy;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  vec4 c = texture2D(uArt, uv);
  vec3 col = (c.rgb - 0.5) * uArtAdj.y + 0.5;
  col *= uArtAdj.x;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uArtAdj.z);
  return vec4(clamp(col, 0.0, 1.0), c.a * uArtAdj.w);
}

void main() {
  float r = length(vP);
  float aa = max(fwidth(r), 1e-4) * 1.2;
  if (r > 1.0) discard;
  float holeR = 0.118;
  float holeMask = uHole > 0.5 ? smoothstep(holeR - aa, holeR + aa, r) : 1.0;
  if (holeMask <= 0.0) discard;
  float outer = 1.0 - smoothstep(1.0 - aa * 1.5, 1.0, r);

  vec2 sp = rot2(uSpin) * vP;              // the spinning surface
  float ang = atan(vP.y, vP.x);            // fixed to the light
  float da = ang - atan(uLight.y, uLight.x);

  float zClear = 1.0 - smoothstep(0.19 - aa, 0.19 + aa, r);
  float zHub = band(r, 0.19, 0.375, aa);
  float zData = band(r, 0.375, 0.972, aa);
  float zRim = smoothstep(0.972 - aa, 0.972 + aa, r);

  // light: a sharp streak with two lobes, a broad sheen, diffraction colours along the radius
  float streak = pow(abs(cos(da)), 18.0 - 10.0 * uMids);
  float broad = pow(abs(cos(da)), 3.0);
  float grazing = 0.65 + 0.35 * (1.0 - vFacing);
  // (a periodic function of the angle: no seam where atan wraps around)
  vec3 rainbow = hue(fract(r * 1.6 + cos(2.0 * da) * 0.06 + uMids * 0.15));
  // fine tracks, faded before they would alias
  float tr = r * 420.0;
  float tracks = (0.5 + 0.5 * sin(tr * 6.2831853)) * (1.0 - smoothstep(0.35, 0.9, fwidth(tr)));

  vec3 base;
  float spec;
  float diff;
  if (uStyle < 0.5) {            // classic silver
    base = vec3(0.56, 0.58, 0.62) * (0.62 + 0.3 * broad) + tracks * 0.03;
    spec = 0.75; diff = 1.25;
  } else if (uStyle < 1.5) {     // dark gloss
    base = vec3(0.025, 0.027, 0.032) + tracks * 0.012;
    spec = 1.15; diff = 0.22;
  } else if (uStyle < 2.5) {     // holographic
    float hh = fract(r * 1.3 + ang * 0.318 + uClock * 0.02 + uMids * 0.15);
    vec3 pastel = mix(hue(hh), vec3(1.0), 0.45);
    base = mix(vec3(0.5, 0.52, 0.57), pastel, 0.42 + 0.25 * broad) * (0.55 + 0.3 * broad) + tracks * 0.03;
    spec = 0.75; diff = 1.1;
  } else if (uStyle < 3.5) {     // minimal matte
    base = mix(vec3(0.68, 0.67, 0.64), uSecondary, 0.1);
    base -= 0.08 * (1.0 - smoothstep(0.0, 0.004 + aa, abs(r - 0.62)));
    base -= 0.05 * (1.0 - smoothstep(0.0, 0.003 + aa, abs(r - 0.86)));
    spec = 0.18; diff = 0.0;
  } else {                       // neon reactive
    base = vec3(0.02, 0.02, 0.03);
    float rings = fract(r * 9.0 - uClock * 0.25);
    float line = 1.0 - smoothstep(0.0, 0.06 + aa * 9.0, abs(rings - 0.5));
    vec3 neon = mix(uPrimary, uSecondary, smoothstep(0.4, 0.95, r));
    base += neon * line * (0.35 + 0.9 * uEnergy + 0.8 * uKick);
    spec = 0.8; diff = 0.35;
  }
  vec3 refl = vec3(0.6) * streak * spec + rainbow * (streak * 0.6 + broad * 0.14) * diff;
  refl *= uReflect * grazing * (0.85 + 0.5 * uMids);
  vec3 dataCol = base + refl;

  // hub: grey polycarbonate with the stacking ring
  vec3 hubCol = vec3(0.46, 0.48, 0.52) * (0.75 + 0.35 * broad) + vec3(0.8) * streak * 0.25 * uReflect;
  if (uRing > 0.5) {
    hubCol += vec3(0.35) * (1.0 - smoothstep(0.0, 0.006 + aa, abs(r - 0.29)));
    hubCol -= vec3(0.12) * (1.0 - smoothstep(0.0, 0.012 + aa, abs(r - 0.305)));
  }
  vec3 clearCol = vec3(0.75, 0.8, 0.86) * (0.25 + 0.5 * streak);
  vec3 rimCol = vec3(0.62, 0.64, 0.68) * (0.3 + 0.5 * broad) + mix(vec3(1.0), uPrimary, 0.6) * (uRim * 0.35 + uKick * 0.9);

  vec3 col = clearCol * zClear + hubCol * zHub + dataCol * zData + rimCol * zRim;
  // the clear ring lets what is behind show through
  float alpha = mix(1.0, 0.42 + 0.3 * streak, zClear);

  if (uHasArt > 0.5) {
    if (uArtMode < 0.5) {                      // full disc art, gloss on top
      vec4 a = artAt(sp);
      float m = a.a * (zHub + zData);
      col = mix(col, a.rgb + refl * 0.3, m);
    } else if (uArtMode < 1.5) {               // centre label only
      float lab = band(r, 0.2, 0.44, aa);
      vec4 a = artAt(sp / 0.44);
      col = mix(col, a.rgb + vec3(0.6) * streak * 0.15 * uReflect, a.a * lab);
      col = mix(col, vec3(0.86), (1.0 - smoothstep(0.0, 0.004 + aa, abs(r - 0.44))) * 0.6);
    } else {                                   // disc print: matte ink on a white base
      float pr = band(r, 0.2, 0.972, aa);
      vec4 a = artAt(sp);
      float grain = hash21(floor(sp * 500.0)) - 0.5;
      vec3 ink = mix(vec3(0.93, 0.92, 0.9), a.rgb, a.a) * (1.0 + grain * 0.04);
      col = mix(col, ink + vec3(1.0) * streak * 0.1 * uReflect, pr);
    }
  }

  // treble: glints fixed on the surface, twinkling
  vec2 g = sp * 38.0;
  vec2 cell = floor(g);
  float h = hash21(cell);
  vec2 f = fract(g) - 0.5 - (vec2(hash21(cell + 3.1), hash21(cell + 7.7)) - 0.5) * 0.6;
  float tw = 0.5 + 0.5 * sin(uClock * (5.0 + h * 9.0) + h * 40.0);
  float sparkle = step(0.86, h) * smoothstep(0.12, 0.0, length(f)) * tw * uTreble;
  col += vec3(1.0) * sparkle * 1.4 * (zData + zHub * 0.4);

  col *= 1.0 + uKick * 0.08;
  gl_FragColor = vec4(max(col, 0.0), alpha * holeMask * outer);
}
`;

const PLANE_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** A soft ring of light around the edge plus a faint haze over the face. */
const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
varying vec2 vP;
void main() {
  float d = length(vP);
  float ring = exp(-pow((d - 1.02) / 0.1, 2.0));
  float haze = exp(-d * d * 1.3) * 0.12;
  gl_FragColor = vec4(uColor * (ring + haze) * uAmount, 1.0);
}
`;

/** Soft drop shadow — round for the disc, a rounded rectangle for the case. */
const SHADOW_FRAG = /* glsl */ `
uniform float uAmount;
uniform vec2 uHalf;
uniform float uRound;
varying vec2 vP;
void main() {
  vec2 q = abs(vP) - uHalf + uRound;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRound;
  float a = 1.0 - smoothstep(-0.25, 0.32, d);
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * a * uAmount);
}
`;

/** The case's front cover: almost clear, a diagonal gloss band and brighter edges. */
const COVER_FRAG = /* glsl */ `
uniform vec2 uHalf;
uniform float uGloss;
varying vec2 vP;
void main() {
  vec2 n = vP / uHalf;
  float band = exp(-pow((n.x * 0.55 + n.y * 0.8 - 0.25) / 0.16, 2.0)) * 0.22 + exp(-pow((n.x * 0.55 + n.y * 0.8 + 0.55) / 0.05, 2.0)) * 0.12;
  float edge = smoothstep(0.9, 1.0, max(abs(n.x), abs(n.y)));
  float a = 0.04 + band * uGloss + edge * 0.18;
  gl_FragColor = vec4(vec3(0.92, 0.95, 1.0), a);
}
`;

export interface DiscFrame {
  dt: number;
  clock: number;
  audio: SceneAudio;
  palette: Palette;
  width: number;
  height: number;
  settings: ParamValues;
  reducedMotion: boolean;
}

function shaderMat(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, blending: THREE.Blending = THREE.NormalBlending): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthTest: false, depthWrite: false, blending, side: THREE.DoubleSide });
}

export class DiscLayer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
  telemetry = { rotation: 0, tilt: 0 };
  /** spin angle (rad, 0..2π) */
  spin = 0;
  private readonly place = new THREE.Group();
  private readonly tilt = new THREE.Group();
  private readonly discGroup = new THREE.Group();
  private readonly caseGroup = new THREE.Group();
  private readonly faceMat: THREE.ShaderMaterial;
  private readonly edgeMat: THREE.MeshBasicMaterial;
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly shadowMat: THREE.ShaderMaterial;
  private readonly coverMat: THREE.ShaderMaterial;
  private readonly shadow: THREE.Mesh;
  private readonly blank: THREE.DataTexture;
  private texture: THREE.Texture | null = null;
  private artId: string | null = null;
  private artSize: [number, number] = [1, 1];
  private readonly bass = new Spring(0, 70, 15);
  private kickHold = 0;
  private kick = 0;
  private kickSeen = -1;
  private mids = 0;
  private treble = 0;
  private level = 0;
  private aspect = 0;

  constructor(segments = 160) {
    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this.blank.needsUpdate = true;

    this.faceMat = shaderMat(DISC_VERT, DISC_FRAG, {
      uSpin: { value: 0 },
      uStyle: { value: 0 },
      uHole: { value: 1 },
      uRing: { value: 1 },
      uReflect: { value: 1 },
      uRim: { value: 0.8 },
      uKick: { value: 0 },
      uMids: { value: 0 },
      uTreble: { value: 0 },
      uEnergy: { value: 0 },
      uClock: { value: 0 },
      uLight: { value: new THREE.Vector2(-0.6, 0.8) },
      uPrimary: { value: new THREE.Color() },
      uSecondary: { value: new THREE.Color() },
      uArt: { value: this.blank },
      uHasArt: { value: 0 },
      uArtMode: { value: 0 },
      uArtXf: { value: new THREE.Vector4(1, 1, 0, 0) },
      uArtRot: { value: 0 },
      uArtAdj: { value: new THREE.Vector4(1, 1, 1, 1) },
    });
    this.edgeMat = new THREE.MeshBasicMaterial({ color: 0x8a8d94, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.glowMat = shaderMat(PLANE_VERT, GLOW_FRAG, { uColor: { value: new THREE.Color() }, uAmount: { value: 0 } }, THREE.AdditiveBlending);
    this.shadowMat = shaderMat(PLANE_VERT, SHADOW_FRAG, { uAmount: { value: 0 }, uHalf: { value: new THREE.Vector2(0.62, 0.62) }, uRound: { value: 0.62 } });
    this.coverMat = shaderMat(PLANE_VERT, COVER_FRAG, { uHalf: { value: new THREE.Vector2(CASE_SIZE.width / 2, CASE_SIZE.height / 2) }, uGloss: { value: 1 } });

    // shadow: cast down-right on what is behind, so it does not tilt with the disc
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), this.shadowMat);
    this.shadow.position.set(0.07, -0.12, -0.6);
    this.shadow.renderOrder = 0;
    this.place.add(this.shadow);

    const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), this.glowMat);
    glow.position.z = -0.05;
    glow.renderOrder = 1;
    this.discGroup.add(glow);
    const edge = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, THICKNESS, segments, 1, true), this.edgeMat);
    edge.rotation.x = Math.PI / 2;
    edge.position.z = -THICKNESS / 2;
    edge.renderOrder = 3;
    this.discGroup.add(edge);
    const face = new THREE.Mesh(new THREE.CircleGeometry(1, segments), this.faceMat);
    face.renderOrder = 4;
    this.discGroup.add(face);

    this.buildCase();
    this.tilt.add(this.caseGroup, this.discGroup);
    this.place.add(this.tilt);
    this.scene.add(this.place);
    this.camera.position.set(0, 0, CAMERA_Z);
  }

  /** Jewel case: back tray, clear frame, hinge spine and the glossy front cover. */
  private buildCase(): void {
    const w = CASE_SIZE.width;
    const h = CASE_SIZE.height;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0x0a0b0e, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }));
    back.position.z = -0.08;
    back.renderOrder = 2;
    const frameMat = new THREE.MeshBasicMaterial({ color: 0xc8d0dc, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false });
    const t = 0.035;
    const depth = 0.16;
    const sides: [number, number, number, number][] = [
      [w, t, 0, h / 2 - t / 2],
      [w, t, 0, -h / 2 + t / 2],
      [t, h, w / 2 - t / 2, 0],
    ];
    for (const [sw, sh, x, y] of sides) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sw, sh, depth), frameMat);
      m.position.set(x, y, 0);
      m.renderOrder = 5;
      this.caseGroup.add(m);
    }
    const spine = new THREE.Mesh(new THREE.BoxGeometry(CASE_SIZE.spine, h, depth), new THREE.MeshBasicMaterial({ color: 0x9aa3b0, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false }));
    spine.position.set(-w / 2 + CASE_SIZE.spine / 2, 0, 0);
    spine.renderOrder = 5;
    const cover = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.coverMat);
    cover.position.z = 0.09;
    cover.renderOrder = 6;
    this.caseGroup.add(back, spine, cover);
    this.caseGroup.visible = false;
  }

  /** Show `art` on the disc (null: the procedural disc). The previous texture is freed. */
  setArtwork(art: DiscArtwork | null): void {
    const id = art?.id ?? null;
    if (id === this.artId) return;
    this.texture?.dispose();
    this.texture = null;
    this.artId = id;
    if (art) {
      const tex = new THREE.Texture(art.source as THREE.Texture['image']);
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      this.texture = tex;
      this.artSize = [art.width, art.height];
    }
    this.faceMat.uniforms.uArt.value = this.texture ?? this.blank;
    this.faceMat.uniforms.uHasArt.value = this.texture ? 1 : 0;
  }

  get artworkTexture(): THREE.Texture | null {
    return this.texture;
  }

  /** Back to the starting state (an export begins here). */
  reset(): void {
    this.spin = 0;
    this.bass.reset(0);
    this.kickHold = 0;
    this.kick = 0;
    this.kickSeen = -1;
    this.mids = 0;
    this.treble = 0;
    this.level = 0;
  }

  update(f: DiscFrame): void {
    const s = f.settings;
    const n = (k: string, d = 0) => (typeof s[k] === 'number' ? (s[k] as number) : d);
    const b = (k: string) => s[k] === true;
    const a = f.audio;
    const dt = Math.max(0, f.dt);
    const boost = n('boost', 1);
    const motion = f.reducedMotion ? 0.4 : 1;

    // ---- audio, smoothed so nothing jumps
    const bass = this.bass.step(Math.min(1.2, (a.bass * 0.65 + a.sub * 0.35) * boost) * motion, dt);
    if (a.kickCount !== this.kickSeen) {
      const first = this.kickSeen < 0;
      this.kickSeen = a.kickCount;
      if (!first) this.kickHold = Math.max(this.kickHold, Math.min(1, a.kickPeak * 1.1));
    }
    this.kickHold = Math.max(0, this.kickHold - dt * 4.5);
    this.kick = attackRelease(this.kick, this.kickHold * boost, dt, 0.025, 0.18);
    this.mids = attackRelease(this.mids, Math.min(1, a.mids * boost), dt, 0.12, 0.45);
    this.treble = attackRelease(this.treble, Math.min(1, a.treble * boost), dt, 0.05, 0.3);
    this.level = attackRelease(this.level, Math.min(1, a.rms * 1.6 * a.activity), dt, 0.8, 1.4);

    // ---- spin: steady base speed, gently faster with the music
    const omega = 2 * Math.PI * BASE_TURNS * n('speed', 1) * (1 + 0.35 * Math.min(1, boost) * this.level) * motion;
    this.spin = (this.spin + omega * dt) % (2 * Math.PI);

    // ---- placement for this frame format
    if (f.width / Math.max(1, f.height) !== this.aspect) {
      this.aspect = f.width / Math.max(1, f.height);
      this.camera.aspect = this.aspect;
      this.camera.updateProjectionMatrix();
    }
    const jewel = b('jewelCase');
    const pl = discPlacement(f.width, f.height, n('size', 1), n('posX'), n('posY'), jewel);
    const unit = (2 * CAMERA_Z * Math.tan(((FOV / 2) * Math.PI) / 180)) / Math.max(1, f.height);
    const pulse = 1 + 0.035 * Math.min(1.2, Math.max(0, bass));
    this.place.position.set((pl.x - f.width / 2) * unit, -(pl.y - f.height / 2) * unit, 0);
    this.place.scale.setScalar(pl.radius * unit * pulse);
    const sway = f.reducedMotion ? 0 : 1;
    const deg = Math.PI / 180;
    this.tilt.rotation.set(n('tiltX', 14) * deg + Math.sin(f.clock * 0.31) * 1.2 * deg * sway, n('tiltY', -10) * deg + Math.sin(f.clock * 0.23 + 1.3) * 1.5 * deg * sway, 0);
    this.caseGroup.visible = jewel;
    this.discGroup.position.x = jewel ? CASE_SIZE.spine / 2 : 0;
    this.shadowMat.uniforms.uAmount.value = n('shadow', 0.6) * 0.78;
    (this.shadowMat.uniforms.uHalf.value as THREE.Vector2).set(jewel ? CASE_SIZE.width / 2 : 0.62, jewel ? CASE_SIZE.height / 2 : 0.62);
    this.shadowMat.uniforms.uRound.value = jewel ? 0.08 : 0.62;

    // ---- materials
    const u = this.faceMat.uniforms;
    u.uSpin.value = this.spin;
    u.uStyle.value = STYLE_INDEX[String(s.style)] ?? 0;
    u.uHole.value = b('hole') ? 1 : 0;
    u.uRing.value = b('centerRing') ? 1 : 0;
    u.uReflect.value = n('reflection', 1);
    u.uRim.value = n('rim', 0.8);
    u.uKick.value = this.kick;
    u.uMids.value = this.mids;
    u.uTreble.value = this.treble;
    u.uEnergy.value = Math.min(1.2, bass);
    u.uClock.value = f.clock;
    (u.uPrimary.value as THREE.Color).copy(f.palette.primary);
    (u.uSecondary.value as THREE.Color).copy(f.palette.secondary);
    if (this.texture) {
      const fit = artworkFit(String(s.artFit), this.artSize[0], this.artSize[1]);
      const scale = Math.max(0.05, n('artScale', 1));
      (u.uArtXf.value as THREE.Vector4).set(fit.sx / scale, fit.sy / scale, n('artOffsetX'), n('artOffsetY'));
      u.uArtRot.value = n('artRotation') * deg;
      (u.uArtAdj.value as THREE.Vector4).set(n('artBrightness', 1), n('artContrast', 1), n('artSaturation', 1), n('artOpacity', 1));
      u.uArtMode.value = MODE_INDEX[String(s.artMode)] ?? 0;
    }
    const rimGlow = n('rim', 0.8) * 0.25 + this.kick * 0.9;
    this.edgeMat.color.setRGB(0.42 + rimGlow * 0.5, 0.43 + rimGlow * 0.5, 0.46 + rimGlow * 0.5);
    (this.glowMat.uniforms.uColor.value as THREE.Color).copy(f.palette.primary);
    this.glowMat.uniforms.uAmount.value = n('glow', 0.6) * (0.22 + 0.2 * Math.min(1, bass)) + this.kick * 0.45 * Math.min(1, n('glow', 0.6) + 0.3);

    this.telemetry.rotation = (this.spin * 180) / Math.PI;
    this.telemetry.tilt = n('tiltX', 14);
  }

  dispose(): void {
    const seen = new Set<unknown>();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !seen.has(m.geometry)) {
        seen.add(m.geometry);
        m.geometry.dispose();
      }
      const mat = m.material as THREE.Material | undefined;
      if (mat && !seen.has(mat)) {
        seen.add(mat);
        mat.dispose();
      }
    });
    this.texture?.dispose();
    this.texture = null;
    this.artId = null;
    this.blank.dispose();
  }
}
