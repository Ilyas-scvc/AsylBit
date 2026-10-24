/**
 * PostProcessingPipeline: renders the scene into an off-screen target, runs the enabled
 * effects in stack order through a ping-pong pair, then grades the result to the screen.
 *
 * Render targets are pooled — scene, 2 × ping-pong and a bloom chain of at most 5 levels —
 * plus one 2-target history per MOTION TRAILS instance (at most MAX_TRAILS). State that
 * belongs to one effect (trail history, kaleidoscope spin) is kept per effect id, so repeated
 * effects animate independently, and is released as soon as that effect stops rendering.
 * All animated effects take time as a uniform, which keeps exports reproducible.
 */
import * as THREE from 'three';
import type { QualityProfile } from '../types';
import { EffectStates } from './effectState';
import type { EffectInstance } from './effects';

interface TrailState {
  targets: THREE.WebGLRenderTarget[];
  fresh: boolean;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }
`;

const OUTPUT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uFade;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  c = (c - 0.5) * uContrast + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c *= uBrightness * uFade;
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;

const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uThreshold;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  // 4-tap box downsample while extracting highlights (soft knee)
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float knee = 0.25;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, l - uThreshold) / max(l, 1e-4);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

// Dual-filter (Kawase) blur: cheap, wide, stable — one pass per mip level each way.
const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv - o).rgb;
  c += texture2D(tSrc, vUv + o).rgb;
  c += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb;
  c += texture2D(tSrc, vUv - vec2(o.x, -o.y)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}
`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tBase;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * (0.5 + uRadius);
  vec3 c = texture2D(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, o.y * 2.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  gl_FragColor = vec4(c / 12.0 + texture2D(tBase, vUv).rgb, 1.0);
}
`;

const BLOOM_MIX_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tBloom;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  vec3 base = texture2D(tSrc, vUv).rgb;
  vec3 b = texture2D(tBloom, vUv).rgb;
  gl_FragColor = vec4(base + b * uIntensity, 1.0);
}
`;

const TRAILS_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tHistory;
uniform float uPersistence;
uniform float uZoom;
uniform float uAngle;
uniform float uAdd;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec3 cur = texture2D(tSrc, vUv).rgb;
  vec2 p = vUv - 0.5;
  p.x *= uAspect;
  float s = sin(uAngle), c = cos(uAngle);
  p = mat2(c, -s, s, c) * p / (1.0 + uZoom);
  p.x /= uAspect;
  vec2 huv = p + 0.5;
  vec3 hist = texture2D(tHistory, huv).rgb * uPersistence;
  float inside = step(0.0, huv.x) * step(huv.x, 1.0) * step(0.0, huv.y) * step(huv.y, 1.0);
  hist *= inside;
  vec3 outc = uAdd > 0.5 ? min(cur + hist, vec3(4.0)) : max(cur, hist);
  gl_FragColor = vec4(outc, 1.0);
}
`;

const KALEIDO_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uSegments;
uniform float uAngle;
uniform float uZoom;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  p.x *= uAspect;
  float r = length(p) / uZoom;
  float a = atan(p.y, p.x) + uAngle;
  float seg = 6.28318530718 / uSegments;
  a = mod(a, seg);
  a = min(a, seg - a);
  vec2 q = vec2(cos(a), sin(a)) * r;
  q.x /= uAspect;
  vec2 uv = q + 0.5;
  // mirror-repeat keeps the folds seamless at the edges
  uv = 1.0 - abs(1.0 - mod(uv, 2.0));
  gl_FragColor = texture2D(tSrc, uv);
}
`;

const CHROMA_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uAmount;
varying vec2 vUv;
void main() {
  vec2 d = vUv - 0.5;
  vec2 off = d * length(d) * uAmount * 0.08;
  float r = texture2D(tSrc, vUv + off).r;
  float g = texture2D(tSrc, vUv).g;
  float b = texture2D(tSrc, vUv - off).b;
  gl_FragColor = vec4(r, g, b, 1.0);
}
`;

const PIXEL_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uResolution;
uniform float uSize;
varying vec2 vUv;
void main() {
  vec2 cell = uSize / uResolution;
  vec2 uv = (floor(vUv / cell) + 0.5) * cell;
  gl_FragColor = texture2D(tSrc, uv);
}
`;

const HASH = /* glsl */ `
float bfHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`;

const GLITCH_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uResolution;
uniform float uAmount;
uniform float uStep;
uniform float uBlock;
uniform float uKick;
varying vec2 vUv;
${HASH}
void main() {
  float row = floor(vUv.y * uResolution.y / uBlock);
  float col = floor(vUv.x * uResolution.x / (uBlock * 4.0));
  float r = bfHash(vec2(row, uStep));
  float strength = clamp(uAmount * 0.35 + uKick * 0.5, 0.0, 1.0);
  float active = step(1.0 - strength * 0.6, r) * step(0.35, bfHash(vec2(col, row + uStep)));
  float shift = (bfHash(vec2(row * 1.7, uStep + 3.1)) - 0.5) * 0.12 * strength * active;
  vec2 uv = vec2(fract(vUv.x + shift), vUv.y);
  float split = 0.006 * strength * active;
  float cr = texture2D(tSrc, uv + vec2(split, 0.0)).r;
  float cg = texture2D(tSrc, uv).g;
  float cb = texture2D(tSrc, uv - vec2(split, 0.0)).b;
  gl_FragColor = vec4(cr, cg, cb, 1.0);
}
`;

const GRAIN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uResolution;
uniform float uAmount;
uniform float uSize;
uniform float uSeed;
varying vec2 vUv;
${HASH}
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  vec2 cell = floor(vUv * uResolution / uSize);
  float n = bfHash(cell + uSeed) + bfHash(cell * 1.37 - uSeed) - 1.0;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += n * uAmount * 0.18 * (1.0 - 0.5 * clamp(l, 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}
`;

const VIGNETTE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform float uAmount;
uniform float uSoftness;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  // circular in screen space, 1.0 at the corners for any aspect ratio
  vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
  float dist = length(d) / length(vec2(uAspect, 1.0) * 0.5);
  float v = 1.0 - smoothstep(1.0 - uSoftness, 1.0, dist);
  gl_FragColor = vec4(c * mix(1.0, v, uAmount), 1.0);
}
`;

export interface GradeSettings {
  brightness: number;
  contrast: number;
  saturation: number;
  fade: number;
}

export interface PostFrame {
  time: number;
  clock: number;
  dt: number;
  kick: number;
}

function makeMaterial(frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
}

export class PostProcessingPipeline {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private quality: QualityProfile;
  private width = 1;
  private height = 1;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private ping: THREE.WebGLRenderTarget[] = [];
  private readonly trails = new EffectStates<TrailState>(
    () => {
      const [w, h] = this.postSize();
      return { targets: [this.makeTarget(w, h, { type: this.floatType }), this.makeTarget(w, h, { type: this.floatType })], fresh: true };
    },
    (t) => t.targets.forEach((rt) => rt.dispose()),
  );
  private readonly kaleido = new EffectStates<{ angle: number }>(() => ({ angle: 0 }));
  private readonly activeIds = new Set<string>();
  private bloom: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private readonly floatType: THREE.TextureDataType;

  private readonly mats = {
    copy: makeMaterial(COPY_FRAG, { tSrc: { value: null } }),
    output: makeMaterial(OUTPUT_FRAG, { tSrc: { value: null }, uBrightness: { value: 1 }, uContrast: { value: 1 }, uSaturation: { value: 1 }, uFade: { value: 1 } }),
    bright: makeMaterial(BRIGHT_FRAG, { tSrc: { value: null }, uThreshold: { value: 0.5 }, uTexel: { value: new THREE.Vector2() } }),
    down: makeMaterial(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }),
    up: makeMaterial(UP_FRAG, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.5 } }),
    bloomMix: makeMaterial(BLOOM_MIX_FRAG, { tSrc: { value: null }, tBloom: { value: null }, uIntensity: { value: 1 } }),
    trails: makeMaterial(TRAILS_FRAG, {
      tSrc: { value: null },
      tHistory: { value: null },
      uPersistence: { value: 0.8 },
      uZoom: { value: 0 },
      uAngle: { value: 0 },
      uAdd: { value: 0 },
      uAspect: { value: 1 },
    }),
    kaleidoscope: makeMaterial(KALEIDO_FRAG, { tSrc: { value: null }, uSegments: { value: 6 }, uAngle: { value: 0 }, uZoom: { value: 1 }, uAspect: { value: 1 } }),
    chromatic: makeMaterial(CHROMA_FRAG, { tSrc: { value: null }, uAmount: { value: 0.3 } }),
    pixelate: makeMaterial(PIXEL_FRAG, { tSrc: { value: null }, uResolution: { value: new THREE.Vector2() }, uSize: { value: 6 } }),
    glitch: makeMaterial(GLITCH_FRAG, {
      tSrc: { value: null },
      uResolution: { value: new THREE.Vector2() },
      uAmount: { value: 0.3 },
      uStep: { value: 0 },
      uBlock: { value: 20 },
      uKick: { value: 0 },
    }),
    grain: makeMaterial(GRAIN_FRAG, { tSrc: { value: null }, uResolution: { value: new THREE.Vector2() }, uAmount: { value: 0.1 }, uSize: { value: 1.4 }, uSeed: { value: 0 } }),
    vignette: makeMaterial(VIGNETTE_FRAG, { tSrc: { value: null }, uAmount: { value: 0.5 }, uSoftness: { value: 0.5 }, uAspect: { value: 1 } }),
  };

  constructor(renderer: THREE.WebGLRenderer, quality: QualityProfile) {
    this.renderer = renderer;
    this.quality = quality;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(geo, this.mats.copy);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    const gl = renderer.getContext();
    const canFloat = renderer.capabilities.isWebGL2 && !!gl.getExtension('EXT_color_buffer_float');
    this.floatType = canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
  }

  /** Number of render targets currently allocated (for diagnostics / tests). */
  get targetCount(): number {
    let trails = 0;
    for (const t of this.trails.values()) trails += t.targets.length;
    return (this.sceneRT ? 1 : 0) + this.ping.length + trails + this.bloom.length + this.bloomUp.length;
  }

  setQuality(q: QualityProfile): void {
    if (q.postScale !== this.quality.postScale || q.bloomLevels !== this.quality.bloomLevels || q.msaa !== this.quality.msaa) {
      this.quality = q;
      this.releaseTargets();
    }
    this.quality = q;
  }

  /** Drawing-buffer size in physical pixels. */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.releaseTargets();
  }

  /** Forget feedback history (scene switch, seek in an export, etc.). */
  resetHistory(): void {
    for (const t of this.trails.values()) t.fresh = true;
    this.kaleido.clear();
  }

  private postSize(): [number, number] {
    const s = this.quality.postScale;
    return [Math.max(1, Math.round(this.width * s)), Math.max(1, Math.round(this.height * s))];
  }

  private makeTarget(w: number, h: number, opts: Partial<THREE.RenderTargetOptions> = {}): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      type: THREE.UnsignedByteType,
      ...opts,
    });
  }

  private ensureTargets(needBloom: boolean): void {
    const [w, h] = this.postSize();
    if (!this.sceneRT) {
      this.sceneRT = this.makeTarget(w, h, { depthBuffer: true, samples: this.quality.msaa });
    }
    if (this.ping.length === 0) this.ping = [this.makeTarget(w, h, { type: this.floatType }), this.makeTarget(w, h, { type: this.floatType })];
    if (needBloom && this.bloom.length === 0) {
      let bw = Math.max(1, w >> 1);
      let bh = Math.max(1, h >> 1);
      for (let i = 0; i < this.quality.bloomLevels; i++) {
        this.bloom.push(this.makeTarget(bw, bh, { type: this.floatType }));
        this.bloomUp.push(this.makeTarget(bw, bh, { type: this.floatType }));
        bw = Math.max(1, bw >> 1);
        bh = Math.max(1, bh >> 1);
      }
    }
  }

  private releaseTargets(): void {
    this.sceneRT?.dispose();
    this.sceneRT = null;
    for (const t of [...this.ping, ...this.bloom, ...this.bloomUp]) t.dispose();
    this.ping = [];
    this.trails.clear();
    this.bloom = [];
    this.bloomUp = [];
  }

  private pass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /** True if `render` would bypass all off-screen work. */
  isDirect(effects: EffectInstance[], grade: GradeSettings): boolean {
    return effects.length === 0 && grade.brightness === 1 && grade.contrast === 1 && grade.saturation === 1 && grade.fade >= 1 && this.quality.postScale === 1;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, effects: EffectInstance[], grade: GradeSettings, frame: PostFrame): void {
    const r = this.renderer;
    if (this.isDirect(effects, grade)) {
      // no effect renders: release what the last ones kept (trail histories, spin angles)
      if (this.trails.size) this.trails.clear();
      if (this.kaleido.size) this.kaleido.clear();
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }
    const needBloom = effects.some((e) => e.type === 'bloom');
    this.ensureTargets(needBloom);
    // per-effect state lives only as long as its effect renders
    this.activeIds.clear();
    for (const e of effects) this.activeIds.add(e.id);
    this.trails.retain(this.activeIds);
    this.kaleido.retain(this.activeIds);
    const [w, h] = this.postSize();
    const aspect = w / h;

    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    let src: THREE.Texture = this.sceneRT!.texture;
    let pingIndex = 0;
    const next = () => {
      const t = this.ping[pingIndex];
      pingIndex ^= 1;
      return t;
    };

    for (const e of effects) {
      const p = e.params;
      const n = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0);
      switch (e.type) {
        case 'bloom': {
          const levels = this.bloom.length;
          if (levels === 0) break;
          const b = this.mats.bright.uniforms;
          b.tSrc.value = src;
          b.uThreshold.value = n('threshold');
          (b.uTexel.value as THREE.Vector2).set(0.5 / w, 0.5 / h);
          this.pass(this.mats.bright, this.bloom[0]);
          for (let i = 1; i < levels; i++) {
            const d = this.mats.down.uniforms;
            d.tSrc.value = this.bloom[i - 1].texture;
            (d.uTexel.value as THREE.Vector2).set(1 / this.bloom[i - 1].width, 1 / this.bloom[i - 1].height);
            this.pass(this.mats.down, this.bloom[i]);
          }
          let up = this.bloom[levels - 1].texture;
          for (let i = levels - 2; i >= 0; i--) {
            const u = this.mats.up.uniforms;
            u.tSrc.value = up;
            u.tBase.value = this.bloom[i].texture;
            (u.uTexel.value as THREE.Vector2).set(1 / this.bloom[i + 1].width, 1 / this.bloom[i + 1].height);
            u.uRadius.value = n('radius');
            this.pass(this.mats.up, this.bloomUp[i]);
            up = this.bloomUp[i].texture;
          }
          const m = this.mats.bloomMix.uniforms;
          m.tSrc.value = src;
          m.tBloom.value = up;
          m.uIntensity.value = n('intensity');
          const dst = next();
          this.pass(this.mats.bloomMix, dst);
          src = dst.texture;
          break;
        }
        case 'trails': {
          const history = this.trails.get(e.id);
          const [read, write] = history.targets;
          const u = this.mats.trails.uniforms;
          u.tSrc.value = src;
          u.tHistory.value = read.texture;
          u.uPersistence.value = history.fresh ? 0 : Math.pow(n('persistence'), frame.dt * 60);
          u.uZoom.value = n('zoom') * frame.dt * 60;
          u.uAngle.value = ((n('rotate') * Math.PI) / 180) * frame.dt;
          u.uAdd.value = p.blend === 'add' ? 1 : 0;
          u.uAspect.value = aspect;
          this.pass(this.mats.trails, write);
          history.targets = [write, read];
          history.fresh = false;
          src = write.texture;
          break;
        }
        case 'kaleidoscope': {
          const spin = this.kaleido.get(e.id);
          spin.angle += ((n('spin') * Math.PI) / 180) * frame.dt;
          const u = this.mats.kaleidoscope.uniforms;
          u.tSrc.value = src;
          u.uSegments.value = Math.max(2, Math.round(n('segments')));
          u.uAngle.value = (n('rotation') * Math.PI) / 180 + spin.angle;
          u.uZoom.value = Math.max(0.05, n('zoom'));
          u.uAspect.value = aspect;
          const dst = next();
          this.pass(this.mats.kaleidoscope, dst);
          src = dst.texture;
          break;
        }
        case 'chromatic': {
          const u = this.mats.chromatic.uniforms;
          u.tSrc.value = src;
          u.uAmount.value = n('amount');
          const dst = next();
          this.pass(this.mats.chromatic, dst);
          src = dst.texture;
          break;
        }
        case 'pixelate': {
          const u = this.mats.pixelate.uniforms;
          u.tSrc.value = src;
          (u.uResolution.value as THREE.Vector2).set(w, h);
          u.uSize.value = Math.max(1, n('size') * this.quality.postScale);
          const dst = next();
          this.pass(this.mats.pixelate, dst);
          src = dst.texture;
          break;
        }
        case 'glitch': {
          const u = this.mats.glitch.uniforms;
          u.tSrc.value = src;
          (u.uResolution.value as THREE.Vector2).set(w, h);
          u.uAmount.value = n('amount');
          u.uStep.value = Math.floor(frame.clock * n('speed') * 8);
          u.uBlock.value = Math.max(2, n('blockSize') * this.quality.postScale);
          u.uKick.value = Math.min(1, frame.kick) * n('audio');
          const dst = next();
          this.pass(this.mats.glitch, dst);
          src = dst.texture;
          break;
        }
        case 'grain': {
          const u = this.mats.grain.uniforms;
          u.tSrc.value = src;
          (u.uResolution.value as THREE.Vector2).set(w, h);
          u.uAmount.value = n('amount');
          u.uSize.value = Math.max(1, n('size') * this.quality.postScale);
          u.uSeed.value = Math.floor(frame.clock * 24) * 0.618;
          const dst = next();
          this.pass(this.mats.grain, dst);
          src = dst.texture;
          break;
        }
        case 'vignette': {
          const u = this.mats.vignette.uniforms;
          u.tSrc.value = src;
          u.uAmount.value = n('amount');
          u.uSoftness.value = n('softness');
          u.uAspect.value = aspect;
          const dst = next();
          this.pass(this.mats.vignette, dst);
          src = dst.texture;
          break;
        }
      }
    }

    const o = this.mats.output.uniforms;
    o.tSrc.value = src;
    o.uBrightness.value = grade.brightness;
    o.uContrast.value = grade.contrast;
    o.uSaturation.value = grade.saturation;
    o.uFade.value = Math.min(1, Math.max(0, grade.fade));
    this.pass(this.mats.output, null);
  }

  dispose(): void {
    this.releaseTargets();
    for (const m of Object.values(this.mats)) m.dispose();
    this.quad.geometry.dispose();
  }
}
