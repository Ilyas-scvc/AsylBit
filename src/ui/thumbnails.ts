/**
 * Scene thumbnails: real renders of each scene's default preset, driven by a fixed
 * synthetic audio frame. One temporary off-screen engine renders them all, then is freed.
 */
import { createAudioFrame, DISPLAY_BANDS, WAVE_POINTS } from '../audio/analysis/frame';
import { builtinForScene } from '../engine/presets/builtins';
import { presetValues } from '../engine/presets/schema';
import { qualityProfile } from '../engine/quality';
import { sceneRegistry } from '../engine/scenes/registry';

const cache = new Map<string, string>();
let running: Promise<Map<string, string>> | null = null;

function demoFrame(t: number) {
  const f = createAudioFrame();
  f.hasTrack = true;
  f.playing = true;
  f.activity = 1;
  f.sub = 0.6;
  f.bass = 0.7 + 0.1 * Math.sin(t * 3);
  f.mid = 0.5;
  f.high = 0.4;
  f.rms = 0.6;
  f.rmsDb = -12;
  f.flux = 0.5;
  f.kick = Math.max(0, Math.sin(t * Math.PI * 2)) * 0.6;
  for (let i = 0; i < DISPLAY_BANDS; i++) f.spectrum[i] = Math.min(1.1, 0.9 * Math.exp(-i / 45) + 0.18 + 0.12 * Math.sin(i * 0.37 + t));
  f.peaks.set(f.spectrum);
  for (let i = 0; i < WAVE_POINTS; i++) f.waveform[i] = 0.5 * Math.sin((i / WAVE_POINTS) * Math.PI * 8);
  return f;
}

export function getThumbnail(id: string): string | undefined {
  return cache.get(id);
}

export function renderThumbnails(width = 320, height = 200): Promise<Map<string, string>> {
  if (running) return running;
  running = (async () => {
    const { VisualizerEngine } = await import('../engine/VisualizerEngine');
    const canvas = document.createElement('canvas');
    const engine = new VisualizerEngine(canvas, { quality: qualityProfile('balanced'), preserveDrawingBuffer: true, sceneFade: 0 });
    engine.setSize(width, height, 1);
    try {
      for (const def of sceneRegistry.list()) {
        if (cache.has(def.id)) continue;
        const preset = builtinForScene(def.id);
        const visual = {
          sceneId: def.id,
          params: preset ? presetValues(preset) : {},
          modulations: preset?.modulations ?? [],
          post: preset?.post ?? [],
        };
        engine.reset();
        for (let k = 0; k < 45; k++) {
          const t = k / 30;
          engine.render({ frame: demoFrame(t), time: t, dt: 1 / 30, visual, reducedMotion: false, exporting: true, skipRender: k < 44 });
        }
        cache.set(def.id, canvas.toDataURL('image/jpeg', 0.82));
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      engine.dispose();
      engine.renderer.forceContextLoss();
    }
    return cache;
  })();
  return running;
}
