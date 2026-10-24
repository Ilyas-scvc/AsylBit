/** Built-in presets: at least one starting point per scene, all original to BEAT//FORM. */
import { createBinding, type ModulationBinding } from '../modulation';
import { createEffect, type EffectInstance, type EffectType } from '../post/effects';
import { exampleZoomBinding, makePreset, type VisualPreset } from './schema';

const T0 = Date.UTC(2026, 9, 1);

function fx(type: EffectType, id: string, params: Record<string, number | string> = {}): EffectInstance {
  const e = createEffect(type, id);
  return { ...e, params: { ...e.params, ...params } };
}

function mod(target: string, source: ModulationBinding['source'], patch: Partial<ModulationBinding> = {}): ModulationBinding {
  return { ...createBinding(target, source, `m-${target.replace(/[^\w]+/g, '-')}-${source}`), ...patch };
}

function preset(id: string, name: string, sceneId: string, values: Record<string, number | string | boolean>, post: EffectInstance[] = [], modulations: ModulationBinding[] = []): VisualPreset {
  return makePreset({ id: `builtin-${id}`, name, sceneId, values, post, modulations, builtIn: true, now: T0 });
}

export const BUILTIN_PRESETS: VisualPreset[] = [
  preset('signal', 'SIGNAL', 'pulse-object', {}),
  preset('bass-zoom', 'SIGNAL · BASS ZOOM', 'pulse-object', { primary: '#ff5b2e' }, [fx('bloom', 'fx-bloom', { intensity: 0.8, threshold: 0.6 })], [
    exampleZoomBinding(),
    mod('fx:fx-bloom:intensity', 'kick', { amount: 0.25, attack: 0.01, release: 0.3 }),
  ]),
  preset('monitor', 'MONITOR', 'radial-spectrum', {}),
  preset('terrain', 'TERRAIN', 'wave-field', {}),
  preset(
    'spiral-bloom',
    'SPIRAL BLOOM',
    'reactive-mesh',
    { layout: 'spiral', spiralTurns: 1.2, dots: 1.1, lines: 0.25, dotSize: 1.1, density: 0.75, tilt: 58, gradient: 'spectrum', primary: '#b14dff', secondary: '#ff4fd8', depth: 0.8, rotation: 0.25 },
    [fx('trails', 'fx-trails', { persistence: 0.72, zoom: 0.004 }), fx('bloom', 'fx-bloom', { intensity: 0.9, threshold: 0.45 })],
    [mod('spiralTurns', 'lfo', { amount: 0.08, lfoRate: 0.03, attack: 0.5, release: 0.5 })],
  ),
  preset('night-grid', 'NIGHT GRID', 'reactive-mesh', { layout: 'flat', lines: 1, dots: 0, tilt: 26, gradient: 'blend' }, [fx('vignette', 'fx-vignette')]),
  preset('bowl', 'BOWL', 'reactive-mesh', { layout: 'bowl', lines: 0.6, dots: 0.8, tilt: 48, gradient: 'frequency', primary: '#3ad8ff', secondary: '#7a5cff' }, [
    fx('bloom', 'fx-bloom', { intensity: 0.7 }),
  ]),
  preset('halo', 'HALO', 'cosmic-rings', { primary: '#ffd23a', secondary: '#ff3a6e', rings: 16 }, [fx('bloom', 'fx-bloom', { intensity: 1, threshold: 0.4 })]),
  preset(
    'mandala',
    'MANDALA',
    'cosmic-rings',
    { rings: 24, symmetry: 12, gradient: 'spectrum', primary: '#3ad8ff', complexity: 0.7, tilt: 0 },
    [fx('kaleidoscope', 'fx-kaleido', { segments: 6, spin: 2 }), fx('bloom', 'fx-bloom', { intensity: 0.8 })],
  ),
  preset('nebula', 'NEBULA', 'particle-cloud', { shape: 0.15, primary: '#7a5cff', secondary: '#3ad8ff', particleSize: 1.2 }, [fx('bloom', 'fx-bloom', { intensity: 1.1, threshold: 0.35 })]),
  preset('galaxy', 'GALAXY', 'particle-cloud', { shape: 1, arms: 4, complexity: 0.6, tilt: 48, primary: '#ffd23a', secondary: '#ff4fa3' }, [fx('bloom', 'fx-bloom'), fx('vignette', 'fx-vignette')], [
    mod('shape', 'lfo', { amount: 0.25, lfoRate: 0.02, attack: 1, release: 1 }),
  ]),
  preset('warp', 'WARP', 'audio-tunnel', {}, [fx('bloom', 'fx-bloom', { intensity: 1.2, threshold: 0.35 }), fx('chromatic', 'fx-chroma', { amount: 0.3 })]),
  preset('hex-drive', 'HEX DRIVE', 'audio-tunnel', { symmetry: 6, primary: '#ff5b2e', secondary: '#ffd23a', complexity: 0.6 }, [fx('trails', 'fx-trails', { persistence: 0.6, zoom: 0.01 })]),
  preset('lava', 'LAVA', 'plasma-flow', {}, [fx('grain', 'fx-grain'), fx('vignette', 'fx-vignette')]),
  preset('aurora', 'AURORA', 'plasma-flow', { primary: '#3affb1', secondary: '#3a6bff', background: '#02060a', deformation: 1.3, trails: 1.1 }, [fx('vignette', 'fx-vignette')]),
  preset('bloom', 'BLOOM', 'fractal-bloom', {}, [fx('bloom', 'fx-bloom', { intensity: 0.9, threshold: 0.4 })]),
  preset('crystal', 'CRYSTAL', 'fractal-bloom', { symmetry: 6, gradient: 'frequency', primary: '#ecece6', secondary: '#d4ff3a', complexity: 0.8, glow: 0.6 }, [
    fx('chromatic', 'fx-chroma', { amount: 0.2 }),
  ]),
];

export const BUILTIN_MAP = new Map(BUILTIN_PRESETS.map((p) => [p.id, p]));

/** The default built-in preset of a scene (the first one listed for it). */
export function builtinForScene(sceneId: string): VisualPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.sceneId === sceneId);
}
