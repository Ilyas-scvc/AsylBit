/**
 * Palette helpers shared by CPU-side scenes and GLSL. The "gradient" parameter decides how
 * a scene spreads its primary → secondary colours:
 *   0 MONO       primary only (secondary used for structure lines)
 *   1 BLEND      mix by intensity
 *   2 FREQUENCY  mix by frequency position (low = primary, high = secondary)
 *   3 SPECTRUM   hue sweep across frequencies, starting at the primary hue
 */
import * as THREE from 'three';

export const GRADIENT_INDEX: Record<string, number> = { mono: 0, blend: 1, frequency: 2, spectrum: 3 };

const tmpHsl = { h: 0, s: 0, l: 0 };

/**
 * Colour for a normalized position `t` (frequency or depth, 0..1) and intensity `level`
 * (0..1), written into `out`.
 */
export function gradientColor(mode: number, t: number, level: number, primary: THREE.Color, secondary: THREE.Color, out: THREE.Color): THREE.Color {
  switch (mode) {
    case 0:
      return out.copy(primary);
    case 2:
      return out.copy(primary).lerp(secondary, Math.min(1, Math.max(0, t)));
    case 3: {
      primary.getHSL(tmpHsl);
      const h = (tmpHsl.h + t * 0.85) % 1;
      return out.setHSL(h, Math.max(0.55, tmpHsl.s), Math.min(0.65, Math.max(0.45, tmpHsl.l)));
    }
    default:
      return out.copy(secondary).lerp(primary, Math.min(1, Math.max(0, level)));
  }
}

/** GLSL twin of `gradientColor` (expects uniforms uPrimary, uSecondary, uGradient). */
export const GLSL_GRADIENT = /* glsl */ `
vec3 bfHue2rgb(float h) {
  vec3 k = vec3(0.0, 2.0 / 3.0, 1.0 / 3.0);
  return clamp(abs(fract(h + k) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
float bfHue(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  if (d < 1e-5) return 0.0;
  float h;
  if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return h / 6.0;
}
vec3 bfGradient(float mode, float t, float level, vec3 primary, vec3 secondary) {
  if (mode < 0.5) return primary;
  if (mode < 1.5) return mix(secondary, primary, clamp(level, 0.0, 1.0));
  if (mode < 2.5) return mix(primary, secondary, clamp(t, 0.0, 1.0));
  vec3 rgb = bfHue2rgb(fract(bfHue(primary) + t * 0.85));
  return mix(vec3(0.5), rgb, 0.92);
}
`;

/** Updates a THREE.Color from a hex string only when it changed. */
export class HexColor {
  readonly color = new THREE.Color();
  private hex = '';
  set(hex: string): THREE.Color {
    if (hex !== this.hex) {
      this.hex = hex;
      this.color.set(hex);
    }
    return this.color;
  }
}
