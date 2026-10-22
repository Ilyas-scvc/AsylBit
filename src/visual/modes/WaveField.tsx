/**
 * MODE 03 — WAVE FIELD
 *
 * A field of ridge lines in 3D. Each row is a snapshot of the music that scrolls away from
 * the viewer, so the field is a moving record of the last ~1.5 s:
 *
 *   x → frequency, mirrored around the centre (lows in the middle, highs at the edges)
 *   bass  → broad, slow swells across the whole row (+ kick wave that travels back)
 *   mid   → bends the geometry: rows warp sideways and the mid region rises
 *   high  → small, fast ripples along the lines
 *
 * The camera drifts very slowly. In silence the rows flatten to a calm, breathing grid.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { analysisHub } from '../../audio/analysis/AnalysisHub';
import { DISPLAY_BANDS } from '../../audio/analysis/frame';
import { useSettings } from '../../state/settings';
import { ColorCache, FadeIn } from '../common';
import type { Detail } from '../runtime';
import { telemetry } from '../telemetry';

const WIDTH = 9;
const DEPTH = 11;
const PUSH_INTERVAL = 1 / 32;
/** per-row scalars stored alongside the spectrum snapshot */
const ROW_BASS = 0;
const ROW_MID = 1;
const ROW_HIGH = 2;
const ROW_KICK = 3;
const ROW_SCALARS = 4;

export function WaveField({ detail, reducedMotion }: { detail: Detail; reducedMotion: boolean }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const ROWS = detail === 'high' ? 60 : 36;
  const COLS = detail === 'high' ? 150 : 90;
  const CROSS_EVERY = detail === 'high' ? 10 : 9;

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(ROWS * COLS * 3), 3);
    const col = new THREE.BufferAttribute(new Float32Array(ROWS * COLS * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('color', col);
    const index: number[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS - 1; c++) index.push(r * COLS + c, r * COLS + c + 1);
    }
    // sparse lines along the depth axis give the field its grid structure
    for (let c = 0; c < COLS; c += CROSS_EVERY) {
      for (let r = 0; r < ROWS - 1; r++) index.push(r * COLS + c, (r + 1) * COLS + c);
    }
    const last = COLS - 1;
    if (last % CROSS_EVERY !== 0) for (let r = 0; r < ROWS - 1; r++) index.push(r * COLS + last, (r + 1) * COLS + last);
    g.setIndex(index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -DEPTH / 2), 14);
    return g;
  }, [ROWS, COLS, CROSS_EVERY]);

  const material = useMemo(
    () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    [],
  );

  // column → interpolated display band (mirrored, low in the middle)
  const columnBands = useMemo(() => {
    const out = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) {
      const x = (c / (COLS - 1)) * 2 - 1;
      out[c] = Math.pow(Math.abs(x), 0.85) * (DISPLAY_BANDS - 1);
    }
    return out;
  }, [COLS]);

  const history = useMemo(
    () => ({
      spec: new Float32Array(ROWS * DISPLAY_BANDS),
      scalars: new Float32Array(ROWS * ROW_SCALARS),
      head: 0,
      timer: 0,
    }),
    [ROWS],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  const st = useRef({ phase: 0, drift: 0, accent: new ColorCache(), fade: new FadeIn(0.8), look: new THREE.Vector3(), tiltX: 0, tiltY: 0 });

  useFrame((three, delta) => {
    const f = analysisHub.frame;
    const s = useSettings.getState();
    const S = st.current;
    const dt = Math.min(delta, 0.1);
    const motion = reducedMotion ? 0.45 : 1;
    const intensity = s.intensity;
    const fade = S.fade.step(dt);
    const accent = S.accent.update(s.accent);
    const act = f.activity;

    S.phase += dt * (0.5 + 1.2 * f.mid * act) * motion;
    S.drift += dt * 0.06 * s.rotationSpeed * motion;

    // ---- push a new row of music into the history ----------------------------------------
    const H = history;
    H.timer += dt * motion;
    while (H.timer >= PUSH_INTERVAL) {
      H.timer -= PUSH_INTERVAL;
      H.head = (H.head + 1) % ROWS;
      H.spec.set(f.spectrum, H.head * DISPLAY_BANDS);
      const o = H.head * ROW_SCALARS;
      H.scalars[o + ROW_BASS] = f.bass;
      H.scalars[o + ROW_MID] = f.mid;
      H.scalars[o + ROW_HIGH] = f.high;
      H.scalars[o + ROW_KICK] = f.kick;
    }
    const frac = H.timer / PUSH_INTERVAL;

    // ---- rebuild vertex heights --------------------------------------------------------
    const pos = geometry.attributes.position.array as Float32Array;
    const col = geometry.attributes.color.array as Float32Array;
    const rowStep = DEPTH / (ROWS - 1);
    const idle = 1 - act;
    const ar = accent.r;
    const ag = accent.g;
    const ab = accent.b;
    for (let r = 0; r < ROWS; r++) {
      const slot = (H.head - r + ROWS) % ROWS;
      const so = slot * DISPLAY_BANDS;
      const sc = slot * ROW_SCALARS;
      const bass = H.scalars[sc + ROW_BASS] * intensity;
      const mid = H.scalars[sc + ROW_MID] * intensity;
      const high = H.scalars[sc + ROW_HIGH] * intensity;
      const kick = H.scalars[sc + ROW_KICK];
      const depth = r + frac;
      const z = 1.3 - depth * rowStep;
      const fadeDepth = Math.pow(Math.max(0, 1 - depth / ROWS), 1.25);
      const warp = mid * 0.32 * Math.sin(z * 0.9 + S.phase * 0.7) * motion;
      for (let c = 0; c < COLS; c++) {
        const x01 = (c / (COLS - 1)) * 2 - 1;
        const bf = columnBands[c];
        const b0 = Math.floor(bf);
        const b1 = Math.min(DISPLAY_BANDS - 1, b0 + 1);
        const t = bf - b0;
        const v = H.spec[so + b0] * (1 - t) + H.spec[so + b1] * t;
        const ax = Math.abs(x01);
        // spectral ridge: tall in the low/mid centre, lower toward the high edges
        let y = Math.pow(v, 1.35) * (1.25 - 0.85 * ax) * 1.1;
        // bass + kick: broad swell centred in the field
        y += (bass * 0.42 + kick * 0.38) * Math.exp(-x01 * x01 * 2.2) * motion;
        // highs: fine fast ripple, strongest at the edges where the highs live
        y += high * 0.05 * Math.sin(x01 * 46 + S.phase * 7 + r * 0.6) * (0.4 + ax) * motion;
        // ambient breathing only while no music is driving the field
        y += idle * 0.07 * Math.sin(x01 * 2.4 + S.phase * 0.5 + z * 0.55) * Math.cos(z * 0.9 - S.phase * 0.35);
        const o = (r * COLS + c) * 3;
        pos[o] = x01 * (WIDTH / 2) + warp * (1 - ax * 0.5);
        pos[o + 1] = y * intensity * 0.82 - 1.0;
        pos[o + 2] = z;
        const lift = Math.min(1, y * 1.3);
        const front = r < 3 ? (1 - r / 3) * 0.45 : 0;
        const tint = Math.min(1, lift * 0.75 + kick * 0.5 + front * lift);
        const bright = (0.16 + 0.84 * Math.min(1, 0.3 + lift)) * fadeDepth * fade;
        col[o] = (0.82 + (ar - 0.82) * tint) * bright;
        col[o + 1] = (0.82 + (ag - 0.82) * tint) * bright;
        col[o + 2] = (0.82 + (ab - 0.82) * tint) * bright;
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;

    // ---- very slow camera drift + hover parallax -----------------------------------------
    const px = reducedMotion ? 0 : three.pointer.x;
    const py = reducedMotion ? 0 : three.pointer.y;
    S.tiltX += (px * 0.6 - S.tiltX) * Math.min(1, dt * 1.5);
    S.tiltY += (py * 0.3 - S.tiltY) * Math.min(1, dt * 1.5);
    // portrait screens / 9:16 export: step back and look further down so the field fills the frame
    const aspect = size.width / Math.max(1, size.height);
    const portrait = Math.min(1, Math.max(0, (1.2 - aspect) / 0.65));
    camera.position.set(
      Math.sin(S.drift) * 1.4 + S.tiltX,
      1.55 + portrait * 2.6 + Math.sin(S.drift * 0.71) * 0.25 + S.tiltY,
      5.2 + portrait * 3.2 + Math.cos(S.drift * 0.53) * 0.35,
    );
    S.look.set(Math.sin(S.drift * 0.8) * 0.4, -0.2 - portrait * 0.6, -2.8 - portrait * 0.6);
    camera.lookAt(S.look);
    telemetry.rotation = (((Math.atan2(camera.position.x - S.look.x, camera.position.z - S.look.z) * 180) / Math.PI) % 360 + 360) % 360;
    telemetry.tilt = (Math.atan2(camera.position.y - S.look.y, camera.position.z - S.look.z) * 180) / Math.PI;
  });

  return <lineSegments geometry={geometry} material={material} />;
}
