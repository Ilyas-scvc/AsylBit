/** Handle on the live stage engine for UI read-outs (modulation meters, resolved values). */
import type { VisualizerEngine } from '../engine/VisualizerEngine';

let live: VisualizerEngine | null = null;

export function setLiveEngine(engine: VisualizerEngine | null): void {
  live = engine;
}

export function getLiveEngine(): VisualizerEngine | null {
  return live;
}
