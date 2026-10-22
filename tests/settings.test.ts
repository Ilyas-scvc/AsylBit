import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, RANGES, clampToRange, darkEnough, resolveReducedMotion, sanitizeSettings } from '../src/state/settings';

describe('settings sanitising', () => {
  it('returns defaults for garbage', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps every numeric setting into its safe range', () => {
    const wild: Record<string, unknown> = {};
    for (const key of Object.keys(RANGES)) wild[key] = 1e9;
    const s = sanitizeSettings(wild);
    for (const [key, r] of Object.entries(RANGES)) expect(s[key as keyof typeof RANGES]).toBe(r.max);
    const low: Record<string, unknown> = {};
    for (const key of Object.keys(RANGES)) low[key] = -1e9;
    const t = sanitizeSettings(low);
    for (const [key, r] of Object.entries(RANGES)) expect(t[key as keyof typeof RANGES]).toBe(r.min);
  });

  it('rejects wrong types and invalid enums / colours', () => {
    const s = sanitizeSettings({
      mode: 'laser',
      accent: 'red',
      background: '#12345',
      bassSensitivity: 'NaN',
      reducedMotion: true,
      fftSize: 1000,
      quality: 'ultra',
    });
    expect(s.mode).toBe(DEFAULT_SETTINGS.mode);
    expect(s.accent).toBe(DEFAULT_SETTINGS.accent);
    expect(s.background).toBe(DEFAULT_SETTINGS.background);
    expect(s.bassSensitivity).toBe(DEFAULT_SETTINGS.bassSensitivity);
    expect(s.reducedMotion).toBe('auto');
    expect(s.fftSize).toBe(2048);
    expect(s.quality).toBe('auto');
  });

  it('keeps valid values', () => {
    const s = sanitizeSettings({ mode: 'wave', accent: '#FF00AA', fftSize: 4096, midSensitivity: 1.7, reducedMotion: 'on' });
    expect(s.mode).toBe('wave');
    expect(s.accent).toBe('#ff00aa');
    expect(s.fftSize).toBe(4096);
    expect(s.midSensitivity).toBe(1.7);
    expect(s.reducedMotion).toBe('on');
  });

  it('accepts numeric strings but clamps them', () => {
    expect(clampToRange('beatImpact', '1.5')).toBe(1.5);
    expect(clampToRange('beatImpact', '7')).toBe(RANGES.beatImpact.max);
  });

  it('keeps custom backgrounds dark enough for white text', () => {
    expect(darkEnough('#000000')).toBe('#000000');
    const fixed = darkEnough('#ffffff');
    const lum = (h: string) => (0.2126 * parseInt(h.slice(1, 3), 16) + 0.7152 * parseInt(h.slice(3, 5), 16) + 0.0722 * parseInt(h.slice(5, 7), 16)) / 255;
    expect(lum(fixed)).toBeLessThanOrEqual(0.221);
  });

  it('resolves reduced motion against the OS preference', () => {
    expect(resolveReducedMotion('auto', true)).toBe(true);
    expect(resolveReducedMotion('auto', false)).toBe(false);
    expect(resolveReducedMotion('on', false)).toBe(true);
    expect(resolveReducedMotion('off', true)).toBe(false);
  });
});
