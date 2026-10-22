/** Small helpers shared by the visual modes (allocation-free in the render loop). */
import * as THREE from 'three';

export { hash01 } from './hash';

/** Distance needed for a sphere of `radius` to fit a perspective camera's view. */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.08): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const fov = Math.min(vFov, hFov);
  return (radius * margin) / Math.sin(fov / 2);
}

/** Updates a THREE.Color from a hex string only when it changed. */
export class ColorCache {
  readonly color = new THREE.Color();
  private hex = '';

  update(hex: string): THREE.Color {
    if (hex !== this.hex) {
      this.hex = hex;
      this.color.set(hex);
    }
    return this.color;
  }
}

/** Eases a value from 0 to 1 over `duration` seconds after mount (mode cross-fade). */
export class FadeIn {
  value = 0;
  constructor(private readonly duration = 0.6) {}
  step(dt: number): number {
    this.value = Math.min(1, this.value + dt / this.duration);
    return this.value * this.value * (3 - 2 * this.value);
  }
}

export function disposeObject(obj: { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }): void {
  obj.geometry?.dispose();
  const m = obj.material;
  if (Array.isArray(m)) m.forEach((x) => x.dispose());
  else m?.dispose();
}
