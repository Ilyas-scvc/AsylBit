/**
 * MODE 02 — RADIAL SPECTRUM
 *
 * 192 radial lines driven by the real FFT, log-spaced from 30 Hz to 16 kHz and mirrored
 * left/right (lows at the top, highs meeting at the bottom). Each band has its own inertia
 * from the analyzer: lows move big and slow, highs small and fast. Past spectra recede
 * into depth as a tunnel of outlines, an oscilloscope ring sits inside, hats and high
 * energy emit particles from the bands that produced them, snares send a shock ring.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { analysisHub } from '../../audio/analysis/AnalysisHub';
import { DISPLAY_BANDS, WAVE_POINTS } from '../../audio/analysis/frame';
import { EventType } from '../../audio/dsp/events';
import { Spring } from '../../audio/dsp/envelope';
import { useSettings } from '../../state/settings';
import { ColorCache, FadeIn, fitDistance, hash01 } from '../common';
import type { Detail } from '../runtime';
import { telemetry } from '../telemetry';

const N = DISPLAY_BANDS * 2;
const R = 1.0;
const DZ = 0.2;
const PUSH_INTERVAL = 1 / 30;
const SHOCK_SEGMENTS = 160;

const COS = new Float32Array(N);
const SIN = new Float32Array(N);
// wedge edges (bar centre ± half width)
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

function lineGeometry(vertexCount: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  const col = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  col.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', pos);
  g.setAttribute('color', col);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);
  return g;
}

function additiveLines(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
}

export function RadialSpectrum({ detail, reducedMotion }: { detail: Detail; reducedMotion: boolean }) {
  const density = useSettings((s) => s.particleDensity);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const K = detail === 'high' ? 34 : 18;
  const P = Math.round((detail === 'high' ? 900 : 400) * density);

  const bars = useMemo(() => {
    // one wedge-shaped quad per band line, so bars have real width at any resolution
    const g = lineGeometry(N * 4);
    const index: number[] = [];
    for (let i = 0; i < N; i++) {
      const v = i * 4;
      index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
    }
    g.setIndex(index);
    return g;
  }, []);
  const caps = useMemo(() => lineGeometry(N * 2), []);
  const rings = useMemo(() => lineGeometry(K * N * 2), [K]);
  const scope = useMemo(() => lineGeometry(WAVE_POINTS * 2), []);
  const shock = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const v: number[] = [];
    for (let i = 0; i < SHOCK_SEGMENTS; i++) {
      const a0 = (i / SHOCK_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / SHOCK_SEGMENTS) * Math.PI * 2;
      v.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return g;
  }, []);
  const particles = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(P * 3).fill(999), 3);
    const col = new THREE.BufferAttribute(new Float32Array(P * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('color', col);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);
    return g;
  }, [P]);
  const sim = useMemo(() => ({ vel: new Float32Array(P * 3), life: new Float32Array(P), maxLife: new Float32Array(P).fill(1), next: 0 }), [P]);
  const history = useMemo(() => ({ data: new Float32Array(K * DISPLAY_BANDS), head: 0, timer: 0 }), [K]);

  const barMat = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    [],
  );
  const capMat = useMemo(additiveLines, []);
  const ringMat = useMemo(additiveLines, []);
  const scopeMat = useMemo(additiveLines, []);
  const shockMat = useMemo(() => new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), []);
  const pointMat = useMemo(
    () => new THREE.PointsMaterial({ size: 2.4, sizeAttenuation: false, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    [],
  );

  useEffect(() => () => rings.dispose(), [rings]);
  useEffect(() => () => particles.dispose(), [particles]);
  useEffect(
    () => () => {
      bars.dispose();
      caps.dispose();
      scope.dispose();
      shock.dispose();
      [barMat, capMat, ringMat, scopeMat, shockMat, pointMat].forEach((m) => m.dispose());
    },
    [bars, caps, scope, shock, barMat, capMat, ringMat, scopeMat, shockMat, pointMat],
  );

  const group = useRef<THREE.Group>(null);
  const shockRef = useRef<THREE.LineSegments>(null);
  const st = useRef({
    spin: 0,
    tiltX: 0,
    tiltY: 0,
    radius: new Spring(R, 300, 26),
    snareSeen: 0,
    hatSeen: 0,
    shockAge: 10,
    shockStrength: 0,
    emit: 0,
    spawnCount: 0,
    accent: new ColorCache(),
    fade: new FadeIn(0.7),
  });

  useFrame((three, delta) => {
    const f = analysisHub.frame;
    const s = useSettings.getState();
    const S = st.current;
    const dt = Math.min(delta, 0.1);
    const motion = reducedMotion ? 0.45 : 1;
    const intensity = s.intensity;
    const fade = S.fade.step(dt);
    const accent = S.accent.update(s.accent);
    const ar = accent.r;
    const ag = accent.g;
    const ab = accent.b;
    const spec = f.spectrum;

    const r0 = S.radius.step(R * (1 + (0.1 * f.bass * intensity + 0.09 * f.kick) * motion), dt);

    // ---- current bars (wedges) + peak-hold caps ------------------------------------------
    const bp = bars.attributes.position.array as Float32Array;
    const bc = bars.attributes.color.array as Float32Array;
    const cp = caps.attributes.position.array as Float32Array;
    const cc = caps.attributes.color.array as Float32Array;
    const lenScale = reducedMotion ? 0.7 : 1;
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
      const dim = (0.1 + 0.15 * k) * fade;
      const bright = (0.35 + 0.65 * k) * fade;
      const cr = (0.85 + (ar - 0.85) * k) * bright;
      const cg = (0.85 + (ag - 0.85) * k) * bright;
      const cb = (0.85 + (ab - 0.85) * k) * bright;
      bc[o] = bc[o + 3] = dim;
      bc[o + 1] = bc[o + 4] = dim;
      bc[o + 2] = bc[o + 5] = dim;
      bc[o + 6] = bc[o + 9] = cr;
      bc[o + 7] = bc[o + 10] = cg;
      bc[o + 8] = bc[o + 11] = cb;
      // peak hold: a short tangential tick where the band last peaked
      const pk = r0 + (0.025 + Math.pow(f.peaks[b], 1.3) * MAXLEN[b] * intensity) * lenScale + 0.025;
      const q = i * 6;
      cp[q] = COS_L[i] * pk;
      cp[q + 1] = SIN_L[i] * pk;
      cp[q + 2] = 0;
      cp[q + 3] = COS_R[i] * pk;
      cp[q + 4] = SIN_R[i] * pk;
      cp[q + 5] = 0;
      const pc2 = Math.min(1, f.peaks[b] * 1.4) * 0.8 * fade;
      cc[q] = cc[q + 3] = pc2;
      cc[q + 1] = cc[q + 4] = pc2;
      cc[q + 2] = cc[q + 5] = pc2;
    }
    bars.attributes.position.needsUpdate = true;
    bars.attributes.color.needsUpdate = true;
    caps.attributes.position.needsUpdate = true;
    caps.attributes.color.needsUpdate = true;

    // ---- history tunnel ----------------------------------------------------------------
    const H = history;
    H.timer += dt;
    while (H.timer >= PUSH_INTERVAL) {
      H.timer -= PUSH_INTERVAL;
      H.head = (H.head + 1) % K;
      H.data.set(spec, H.head * DISPLAY_BANDS);
    }
    const frac = H.timer / PUSH_INTERVAL;
    const rp = rings.attributes.position.array as Float32Array;
    const rc = rings.attributes.color.array as Float32Array;
    for (let k = 0; k < K; k++) {
      const slot = ((H.head - k + K) % K) * DISPLAY_BANDS;
      const depth = k + frac;
      const z = -depth * DZ * motion - 0.02;
      const alpha = Math.pow(Math.max(0, 1 - depth / K), 1.6) * 0.5 * fade;
      const ringBase = r0 * (1 + depth * 0.012);
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const vi = H.data[slot + BAND[i]];
        const vj = H.data[slot + BAND[j]];
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
        const t = k < 2 ? 0.6 : 0.15;
        const cr = (0.85 + (ar - 0.85) * t) * w;
        const cg = (0.85 + (ag - 0.85) * t) * w;
        const cb = (0.85 + (ab - 0.85) * t) * w;
        rc[o] = cr;
        rc[o + 1] = cg;
        rc[o + 2] = cb;
        rc[o + 3] = cr;
        rc[o + 4] = cg;
        rc[o + 5] = cb;
      }
    }
    rings.attributes.position.needsUpdate = true;
    rings.attributes.color.needsUpdate = true;

    // ---- oscilloscope ring -------------------------------------------------------------
    const sp = scope.attributes.position.array as Float32Array;
    const sc = scope.attributes.color.array as Float32Array;
    const scopeR = r0 * 0.6;
    const amp = 0.28 * f.activity * intensity * motion;
    for (let i = 0; i < WAVE_POINTS; i++) {
      const j = (i + 1) % WAVE_POINTS;
      const a0 = (i / WAVE_POINTS) * Math.PI * 2;
      const a1 = (j / WAVE_POINTS) * Math.PI * 2;
      const q0 = scopeR + f.waveform[i] * amp;
      const q1 = scopeR + f.waveform[j] * amp;
      const o = i * 6;
      sp[o] = Math.cos(a0) * q0;
      sp[o + 1] = Math.sin(a0) * q0;
      sp[o + 2] = 0.01;
      sp[o + 3] = Math.cos(a1) * q1;
      sp[o + 4] = Math.sin(a1) * q1;
      sp[o + 5] = 0.01;
      const c = (0.22 + 0.4 * f.activity) * fade;
      sc[o] = sc[o + 3] = c;
      sc[o + 1] = sc[o + 4] = c;
      sc[o + 2] = sc[o + 5] = c;
    }
    scope.attributes.position.needsUpdate = true;
    scope.attributes.color.needsUpdate = true;

    // ---- snare shock ring --------------------------------------------------------------
    if (f.counts[EventType.SNARE] !== S.snareSeen) {
      S.snareSeen = f.counts[EventType.SNARE];
      S.shockAge = 0;
      S.shockStrength = Math.min(1, f.lastStrength[EventType.SNARE] * s.beatImpact);
    }
    S.shockAge += dt;
    if (shockRef.current) {
      const life = Math.max(0, 1 - S.shockAge / 0.55);
      shockRef.current.scale.setScalar(r0 + S.shockAge * 2.6 * motion);
      shockMat.opacity = life * life * S.shockStrength * 0.7 * fade * (reducedMotion ? 0.4 : 1);
      shockMat.color.copy(accent);
    }

    // ---- particles: emitted by highs and hats from the bands that sound -----------------
    const hatNew = f.counts[EventType.HAT] !== S.hatSeen;
    if (hatNew) S.hatSeen = f.counts[EventType.HAT];
    if (f.playing && !reducedMotion) {
      S.emit += dt * f.high * f.high * 110 * density * f.activity;
      if (hatNew) S.emit += 8 * f.lastStrength[EventType.HAT] * density;
    }
    let bestBand = 60;
    let bestVal = 0;
    for (let b = 52; b < DISPLAY_BANDS; b++) {
      if (spec[b] > bestVal) {
        bestVal = spec[b];
        bestBand = b;
      }
    }
    const pp = particles.attributes.position.array as Float32Array;
    const pc = particles.attributes.color.array as Float32Array;
    while (S.emit >= 1 && P > 0) {
      S.emit -= 1;
      const n = S.spawnCount++;
      const idx = sim.next;
      sim.next = (sim.next + 1) % P;
      const jitterBand = Math.max(40, Math.min(DISPLAY_BANDS - 1, bestBand + Math.round((hash01(n) - 0.5) * 14)));
      const line = hash01(n * 3.1) < 0.5 ? jitterBand : N - 1 - jitterBand;
      const len = 0.025 + Math.pow(spec[jitterBand], 1.3) * MAXLEN[jitterBand] * intensity;
      const rr = r0 + len;
      pp[idx * 3] = COS[line] * rr;
      pp[idx * 3 + 1] = SIN[line] * rr;
      pp[idx * 3 + 2] = 0;
      const speed = 0.45 + 0.9 * hash01(n * 1.7);
      sim.vel[idx * 3] = COS[line] * speed;
      sim.vel[idx * 3 + 1] = SIN[line] * speed;
      sim.vel[idx * 3 + 2] = (hash01(n * 5.3) - 0.5) * 0.4;
      sim.maxLife[idx] = 0.5 + 0.8 * hash01(n * 2.9);
      sim.life[idx] = sim.maxLife[idx];
    }
    if (S.emit > 50) S.emit = 0;
    for (let i = 0; i < P; i++) {
      const life = sim.life[i];
      const o = i * 3;
      if (life <= 0) {
        pc[o] = pc[o + 1] = pc[o + 2] = 0;
        continue;
      }
      sim.life[i] = life - dt;
      pp[o] += sim.vel[o] * dt;
      pp[o + 1] += sim.vel[o + 1] * dt;
      pp[o + 2] += sim.vel[o + 2] * dt;
      const k = Math.max(0, life / sim.maxLife[i]) * fade;
      const w = hash01(i) < 0.35 ? 1 : 0;
      pc[o] = (ar + (1 - ar) * w) * k;
      pc[o + 1] = (ag + (1 - ag) * w) * k;
      pc[o + 2] = (ab + (1 - ab) * w) * k;
    }
    particles.attributes.position.needsUpdate = true;
    particles.attributes.color.needsUpdate = true;

    // ---- motion ------------------------------------------------------------------------
    S.spin += dt * 0.05 * s.rotationSpeed * motion;
    const px = reducedMotion ? 0 : three.pointer.x;
    const py = reducedMotion ? 0 : three.pointer.y;
    S.tiltX += (py * 0.2 - S.tiltX) * Math.min(1, dt * 2.5);
    S.tiltY += (px * 0.28 - S.tiltY) * Math.min(1, dt * 2.5);
    if (group.current) group.current.rotation.set(0.38 - S.tiltX, -0.3 + S.tiltY, S.spin);
    telemetry.rotation = (((S.spin * 180) / Math.PI) % 360 + 360) % 360;
    telemetry.tilt = ((0.38 - S.tiltX) * 180) / Math.PI;

    const dist = fitDistance(2.05, camera.fov, size.width / Math.max(1, size.height));
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, -0.8);
  });

  return (
    <group ref={group}>
      <lineSegments geometry={rings} material={ringMat} />
      <mesh geometry={bars} material={barMat} />
      <lineSegments geometry={caps} material={capMat} />
      <lineSegments geometry={scope} material={scopeMat} />
      <lineSegments ref={shockRef} geometry={shock} material={shockMat} />
      <points geometry={particles} material={pointMat} />
    </group>
  );
}
