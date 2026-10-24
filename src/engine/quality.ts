/** Performance presets for the live stage and the video renderer. */
import type { PerformancePreset, QualityProfile } from './types';

export const PERFORMANCE_PRESETS: { id: PerformancePreset; label: string; hint: string }[] = [
  { id: 'eco', label: 'ECO', hint: 'Integrated GPUs, battery: low detail, reduced post' },
  { id: 'balanced', label: 'BALANCED', hint: 'Default: adapts to the measured frame rate' },
  { id: 'quality', label: 'QUALITY', hint: 'Dedicated GPUs: full detail' },
  { id: 'ultra', label: 'ULTRA', hint: 'Fast GPUs: maximum particles and resolution' },
];

const PROFILES: Record<PerformancePreset, QualityProfile> = {
  eco: { id: 'eco', detail: 'low', particles: 0.35, maxDpr: 1, postScale: 0.6, bloomLevels: 3, maxEffects: 3, msaa: 0 },
  balanced: { id: 'balanced', detail: 'low', particles: 0.6, maxDpr: 1.25, postScale: 0.85, bloomLevels: 4, maxEffects: 5, msaa: 0 },
  quality: { id: 'quality', detail: 'high', particles: 1, maxDpr: 1.75, postScale: 1, bloomLevels: 5, maxEffects: 8, msaa: 4 },
  ultra: { id: 'ultra', detail: 'high', particles: 1.6, maxDpr: 2, postScale: 1, bloomLevels: 5, maxEffects: 8, msaa: 4 },
};

export function qualityProfile(preset: PerformancePreset): QualityProfile {
  return PROFILES[preset] ?? PROFILES.balanced;
}

/** Map the v1 `quality` setting onto a performance preset. */
export function presetFromLegacyQuality(q: unknown): PerformancePreset {
  return q === 'high' ? 'quality' : q === 'low' ? 'eco' : 'balanced';
}

export function isPerformancePreset(v: unknown): v is PerformancePreset {
  return v === 'eco' || v === 'balanced' || v === 'quality' || v === 'ultra';
}
