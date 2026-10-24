/** Helpers shared by scene implementations. */
import * as THREE from 'three';

export { SIMPLEX_NOISE_3D } from '../../visual/shaders/noise';
export { hash01 } from '../../visual/hash';

/** Seeded PRNG (mulberry32): reproducible "randomness" for layouts and particles. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dispose every geometry, material and texture uniform under `root`. */
export function disposeTree(root: THREE.Object3D): void {
  const seen = new Set<unknown>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry && !seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      const uniforms = (m as THREE.ShaderMaterial).uniforms;
      if (uniforms) {
        for (const u of Object.values(uniforms)) {
          const v = u.value as unknown;
          if (v instanceof THREE.Texture && !seen.has(v)) {
            seen.add(v);
            v.dispose();
          }
        }
      }
      m.dispose();
    }
  });
}

/** Vertex shader for scenes that draw a full-screen quad in clip space. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** A clip-space triangle covering the viewport; never culled, drawn behind everything. */
export function fullscreenMesh(material: THREE.ShaderMaterial): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  material.depthTest = false;
  material.depthWrite = false;
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

/** Direction multiplier from the "Motion direction" parameter. */
export function directionSign(dir: string): number {
  return dir === 'reverse' ? -1 : 1;
}

export function wrapDegrees(v: number): number {
  return ((v % 360) + 360) % 360;
}
