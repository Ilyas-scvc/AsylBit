/**
 * The renderer chunk fails to load (offline, deployment swapped under an open tab) after the
 * user already chose a file to write: the file must be released untouched and the error shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/controller', () => ({
  engine: { pause() {} },
  getCurrentFile: () => new File([new Uint8Array(4)], 'track.wav'),
}));
vi.mock('../src/export/RenderController', () => {
  throw new Error('Failed to fetch dynamically imported module: /assets/RenderController.js');
});

const { startExport, useStudio } = await import('../src/export/studio');
const { usePlayer } = await import('../src/state/player');
const { useRuntime } = await import('../src/visual/runtime');

const disk = { closeCalls: 0, abortCalls: 0, async write() {}, async close() { this.closeCalls++; }, async abort() { this.abortCalls++; } };

beforeEach(() => {
  usePlayer.setState({ duration: 10, status: 'ready' });
  vi.stubGlobal('window', { showSaveFilePicker: async () => ({ createWritable: async () => disk }) });
});
afterEach(() => vi.unstubAllGlobals());

describe('startExport when the renderer cannot be loaded', () => {
  it('reports the failure, releases the file without replacing it and resets the stage', async () => {
    await startExport(
      { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: 1280, height: 720, fps: 30, quality: 'standard', videoBitrate: 3e6, audioBitrate: 192000, start: 0, end: 5 },
      'balanced',
      true,
    );
    expect(useStudio.getState().status).toBe('error');
    expect(useStudio.getState().error).toMatch(/FAILED TO LOAD/);
    expect(disk.abortCalls).toBe(1);
    expect(disk.closeCalls).toBe(0);
    expect(useRuntime.getState().offlineExport).toBe(false);
  });
});
