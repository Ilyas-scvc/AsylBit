/**
 * MODE 01 — PULSE OBJECT
 *
 * A dense icosphere displaced in the vertex shader by three octaves of simplex noise and
 * shaded as a "topographic" object: iso-lines of the displacement field drawn with
 * screen-space anti-aliasing plus a fresnel rim in the accent colour.
 *
 *   bass  → overall scale (spring) and the large-scale lobes
 *   kick  → a short, accented scale impulse + rim flash (spring returns it smoothly)
 *   mid   → amplitude of the mid octave (surface folding) and flow speed
 *   high  → fine ripple octave + a particle shell whose points light up with the highs
 *   snare → a ring-shaped ripple travelling across the surface
 *
 * In silence every music-driven term goes to zero and only a slow "breathing" remains.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { analysisHub } from '../../audio/analysis/AnalysisHub';
import { EventType } from '../../audio/dsp/events';
import { Spring } from '../../audio/dsp/envelope';
import { useSettings } from '../../state/settings';
import { ColorCache, FadeIn, fitDistance, hash01 } from '../common';
import { SIMPLEX_NOISE_3D } from '../shaders/noise';
import type { Detail } from '../runtime';
import { telemetry } from '../telemetry';

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
uniform float uFade;
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
  gl_FragColor = vec4(col * uFade, 1.0);
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
uniform float uFade;
varying float vAlpha;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float soft = 1.0 - smoothstep(0.25, 0.5, r);
  vec3 col = mix(uLine, uAccent, step(0.72, vSeed));
  gl_FragColor = vec4(col * vAlpha * soft * uFade, 1.0);
}
`;

/** Fibonacci sphere shell with deterministic radial jitter. */
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

/** Dial ring with tick marks around the object. */
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

export function PulseObject({ detail, reducedMotion }: { detail: Detail; reducedMotion: boolean }) {
  const particleDensity = useSettings((s) => s.particleDensity);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const pixelRatio = useThree((s) => s.viewport.dpr);

  const blobGeometry = useMemo(() => new THREE.IcosahedronGeometry(1, detail === 'high' ? 64 : 32), [detail]);
  const shellCount = Math.round((detail === 'high' ? 5200 : 2400) * particleDensity);
  const shellGeometry = useMemo(() => makeShell(shellCount), [shellCount]);
  const dialGeometry = useMemo(() => makeDial(), []);

  const blobMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
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
          uAccent: { value: new THREE.Color() },
          uLine: { value: new THREE.Color(0.92, 0.92, 0.9) },
          uBase: { value: new THREE.Color() },
          uDensity: { value: 42 },
          uShift: { value: 0 },
          uGlow: { value: 0 },
          uLineBoost: { value: 0 },
          uFade: { value: 0 },
        },
      }),
    [],
  );
  const shellMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
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
          uLine: { value: new THREE.Color(0.92, 0.92, 0.9) },
          uFade: { value: 0 },
        },
      }),
    [],
  );
  const dialMaterial = useMemo(() => new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false }), []);

  useEffect(() => () => blobGeometry.dispose(), [blobGeometry]);
  useEffect(() => () => shellGeometry.dispose(), [shellGeometry]);
  useEffect(
    () => () => {
      dialGeometry.dispose();
      blobMaterial.dispose();
      shellMaterial.dispose();
      dialMaterial.dispose();
    },
    [dialGeometry, blobMaterial, shellMaterial, dialMaterial],
  );

  const group = useRef<THREE.Group>(null);
  const dial = useRef<THREE.LineSegments>(null);
  const state = useRef({
    phase: 0,
    yaw: 0,
    tiltX: 0,
    tiltY: 0,
    scale: new Spring(1, 260, 24),
    snareSeen: 0,
    snareAge: 10,
    snareDir: new THREE.Vector3(0, 1, 0),
    accent: new ColorCache(),
    bg: new ColorCache(),
    fade: new FadeIn(0.7),
    shift: 0,
  });

  useFrame((three, delta) => {
    const f = analysisHub.frame;
    const s = useSettings.getState();
    const st = state.current;
    const dt = Math.min(delta, 0.1);
    const intensity = s.intensity;
    const motion = reducedMotion ? 0.45 : 1;
    const act = f.activity;

    const bass = f.bass * intensity;
    const mid = f.mid * intensity;
    const high = f.high * intensity;
    const kick = f.kick;

    // organic flow speed: slow idle drift, faster with mid-range energy
    st.phase += dt * (0.18 + 0.55 * mid * act) * motion;
    st.shift += dt * (0.05 + 0.25 * f.flux * act) * motion;

    // snare ripple: each snare starts a new wave from a new direction (golden-angle walk)
    if (f.counts[EventType.SNARE] !== st.snareSeen) {
      st.snareSeen = f.counts[EventType.SNARE];
      const k = st.snareSeen * 2.399963;
      const y = Math.cos(k * 0.61);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      st.snareDir.set(Math.cos(k) * r, y, Math.sin(k) * r);
      st.snareAge = 0;
    }
    st.snareAge += dt;

    const target = 1 + (0.13 * bass + 0.11 * kick) * motion;
    const sc = st.scale.step(target, dt);

    const u = blobMaterial.uniforms;
    u.uPhase.value = st.phase;
    u.uBass.value = bass * motion;
    u.uMid.value = mid * motion;
    u.uHigh.value = high * motion;
    u.uIdle.value = 1 - act;
    u.uScale.value = sc;
    u.uSnare.value = f.snare * motion;
    u.uSnarePhase.value = Math.min(Math.PI, st.snareAge * 5.5);
    (u.uSnareDir.value as THREE.Vector3).copy(st.snareDir);
    (u.uAccent.value as THREE.Color).copy(st.accent.update(s.accent));
    const bg = st.bg.update(s.background);
    (u.uBase.value as THREE.Color).setRGB(bg.r * 1.6 + 0.012, bg.g * 1.6 + 0.012, bg.b * 1.6 + 0.012);
    u.uShift.value = st.shift;
    u.uGlow.value = Math.min(1.1, 0.3 * bass + 0.7 * kick);
    u.uLineBoost.value = Math.min(1, 0.6 * mid + 0.5 * kick);
    const fade = st.fade.step(dt);
    u.uFade.value = fade;

    const su = shellMaterial.uniforms;
    su.uPhase.value = st.phase;
    su.uHigh.value = high;
    su.uHat.value = f.hat * motion;
    su.uIdle.value = 1 - act;
    su.uPixelRatio.value = pixelRatio;
    su.uScale.value = sc;
    (su.uAccent.value as THREE.Color).copy(u.uAccent.value as THREE.Color);
    su.uFade.value = fade;

    // slow continuous rotation + hover parallax
    st.yaw += dt * 0.12 * s.rotationSpeed * motion;
    const px = reducedMotion ? 0 : three.pointer.x;
    const py = reducedMotion ? 0 : three.pointer.y;
    st.tiltX += (py * 0.18 - st.tiltX) * Math.min(1, dt * 2.5);
    st.tiltY += (px * 0.25 - st.tiltY) * Math.min(1, dt * 2.5);
    if (group.current) {
      const rx = 0.32 + st.tiltX + Math.sin(st.phase * 0.21) * 0.06;
      group.current.rotation.set(rx, st.yaw + st.tiltY, 0.08);
      telemetry.rotation = ((((st.yaw + st.tiltY) * 180) / Math.PI) % 360 + 360) % 360;
      telemetry.tilt = (rx * 180) / Math.PI;
    }
    if (dial.current) {
      dial.current.rotation.z = -st.yaw * 0.5;
      dial.current.scale.setScalar(BODY_SCALE * 2.08 + 0.06 * kick * motion);
      dialMaterial.opacity = (0.16 + 0.45 * kick + 0.1 * bass) * fade;
      dialMaterial.color.copy(WHITE).lerp(u.uAccent.value as THREE.Color, Math.min(1, kick * 1.4));
    }

    // keep the body framed for any aspect ratio (incl. 9:16 export); the dial may bleed out
    const dist = fitDistance(2.05, camera.fov, size.width / Math.max(1, size.height));
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);
  });

  return (
    <>
      <group ref={group} scale={BODY_SCALE}>
        <mesh geometry={blobGeometry} material={blobMaterial} />
        <points geometry={shellGeometry} material={shellMaterial} />
      </group>
      <lineSegments ref={dial} geometry={dialGeometry} material={dialMaterial} />
    </>
  );
}

const WHITE = new THREE.Color(1, 1, 1);
/** world size of the unit blob */
const BODY_SCALE = 1.18;
