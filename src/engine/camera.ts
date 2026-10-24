/**
 * Shared camera rig. Every scene frames a "subject sphere" of `fitRadius` around `target`;
 * the rig turns the standard camera parameters into a camera pose and keeps the subject in
 * frame for any aspect ratio — so 16:9, 9:16 and 1:1 all compose correctly instead of
 * cropping the centre of a landscape frame.
 */
import * as THREE from 'three';
import type { SceneFrameContext } from './types';

export interface CameraRig {
  /** radius of the subject to keep in frame */
  fitRadius: number;
  target?: THREE.Vector3;
  /** default elevation (deg, positive looks down at the subject) */
  elevation?: number;
  /** default azimuth (deg) */
  azimuth?: number;
  /** scene default field of view, used when the scene does not expose FOV */
  fov?: number;
  /** pointer parallax strength (live only) */
  parallax?: number;
  /** framing margin */
  margin?: number;
}

const ORIGIN = new THREE.Vector3();
const DEG = Math.PI / 180;

/** Distance at which a sphere of `radius` fits a camera of `fovDeg` and `aspect`. */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.08): number {
  const vFov = fovDeg * DEG;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const fov = Math.min(vFov, hFov);
  return (radius * margin) / Math.sin(fov / 2);
}

/** Effective FOV after the "perspective" (flatten) control: 0 is near-orthographic. */
export function effectiveFov(fov: number, perspective: number): number {
  return 8 + (fov - 8) * Math.min(1, Math.max(0, perspective));
}

/**
 * Field of view of a lens zoom: magnifies the image by `zoom` (like PerspectiveCamera.zoom)
 * by scaling tan(fov/2), so it never reaches or passes 180°. Clamped to a usable range.
 */
export function zoomedFov(fovDeg: number, zoom: number): number {
  const z = Math.max(0.05, zoom);
  const fov = (2 * Math.atan(Math.tan((Math.min(179, Math.max(1, fovDeg)) * DEG) / 2) / z)) / DEG;
  return Math.min(170, Math.max(1, fov));
}

/** Neutral state of the shared camera, applied when a scene takes over. */
export function resetCamera(cam: THREE.PerspectiveCamera): void {
  cam.fov = 35;
  cam.zoom = 1;
  cam.near = 0.05;
  cam.far = 200;
  cam.position.set(0, 0, 6);
  cam.up.set(0, 1, 0);
  cam.lookAt(ORIGIN);
  cam.updateProjectionMatrix();
}

export function applyCamera(ctx: SceneFrameContext, rig: CameraRig): { azimuth: number; elevation: number; distance: number } {
  const p = ctx.params;
  const cam = ctx.camera;
  const target = rig.target ?? ORIGIN;
  const fov = p.has('fov') ? p.num('fov') : rig.fov ?? 35;
  const perspective = p.has('perspective') ? p.num('perspective') : 1;
  const zoom = p.has('zoom') ? Math.max(0.05, p.num('zoom')) : 1;
  const dolly = p.has('distance') ? p.num('distance') : 1;
  const effFov = effectiveFov(fov, perspective);
  const distance = fitDistance(rig.fitRadius / zoom, effFov, ctx.aspect, rig.margin ?? 1.08) * dolly;

  const orbit = p.has('autoOrbit') ? p.num('autoOrbit') * ctx.clock : 0;
  const parallax = ctx.exporting || ctx.reducedMotion ? 0 : rig.parallax ?? 0;
  const azimuth = (rig.azimuth ?? 0) + (p.has('cameraRotation') ? p.num('cameraRotation') : 0) + orbit + ctx.pointer.x * parallax * 20;
  const elevation = Math.max(-85, Math.min(85, (rig.elevation ?? 0) + ctx.pointer.y * parallax * 12));

  const az = azimuth * DEG;
  const el = elevation * DEG;
  cam.fov = effFov;
  cam.near = Math.max(0.01, distance * 0.01);
  cam.far = distance * 30 + 60;
  cam.position.set(target.x + Math.sin(az) * Math.cos(el) * distance, target.y + Math.sin(el) * distance, target.z + Math.cos(az) * Math.cos(el) * distance);
  cam.up.set(0, 1, 0);
  cam.lookAt(target);
  cam.updateProjectionMatrix();
  return { azimuth, elevation, distance };
}
