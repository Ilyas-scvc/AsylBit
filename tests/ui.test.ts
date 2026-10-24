import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fitBox, inRestoreCorner, PREVIEW_ASPECTS, useUi } from '../src/state/ui';
import { ContextLossMonitor, FrameGovernor } from '../src/visual/runtime';

const initial = useUi.getState();

describe('HIDE UI / immersive mode', () => {
  beforeEach(() => useUi.setState(initial, true));

  it('hides and restores the interface (H toggles, SHOW UI restores)', () => {
    useUi.getState().hideUi();
    expect(useUi.getState().hidden).toBe(true);
    useUi.getState().toggleUi();
    expect(useUi.getState().hidden).toBe(false);
    useUi.getState().toggleUi();
    useUi.getState().showUi();
    expect(useUi.getState().hidden).toBe(false);
  });

  it('keeps panel state while hidden, so restoring brings the same layout back', () => {
    const ui = useUi.getState();
    ui.openInspector('fx');
    ui.setPreviewAspect('9:16');
    ui.hideUi();
    ui.showUi();
    const s = useUi.getState();
    expect(s.inspectorOpen).toBe(true);
    expect(s.inspectorTab).toBe('fx');
    expect(s.previewAspect).toBe('9:16');
  });

  it('Esc leaves immersive mode first, then closes panels top-down', () => {
    const ui = useUi.getState();
    ui.openInspector();
    ui.setBrowser(true);
    ui.setExport(true);
    ui.hideUi();
    expect(useUi.getState().escape(false)).toBe(true);
    expect(useUi.getState().hidden).toBe(false);
    expect(useUi.getState().exportOpen).toBe(true);
    useUi.getState().escape(false);
    expect(useUi.getState().exportOpen).toBe(false);
    useUi.getState().escape(false);
    expect(useUi.getState().browserOpen).toBe(false);
    useUi.getState().escape(false);
    expect(useUi.getState().inspectorOpen).toBe(false);
    expect(useUi.getState().escape(false)).toBe(false);
  });

  it('Esc does not close the export studio while a render is running', () => {
    useUi.getState().setExport(true);
    expect(useUi.getState().escape(true)).toBe(false);
    expect(useUi.getState().exportOpen).toBe(true);
  });

  it('shows the restore control only in the top-right corner', () => {
    expect(inRestoreCorner(1900, 20, 1920)).toBe(true);
    expect(inRestoreCorner(1790, 139, 1920)).toBe(true);
    expect(inRestoreCorner(1700, 20, 1920)).toBe(false);
    expect(inRestoreCorner(1900, 300, 1920)).toBe(false);
  });
});

describe('preview frame', () => {
  it('letterboxes to the exact export aspect inside any window', () => {
    for (const a of PREVIEW_ASPECTS) {
      if (!a.ratio) continue;
      for (const [w, h] of [
        [1920, 1080],
        [390, 844],
        [1024, 1024],
      ]) {
        const box = fitBox(w, h, a.ratio);
        expect(box.width).toBeLessThanOrEqual(w);
        expect(box.height).toBeLessThanOrEqual(h);
        expect(Math.abs(box.width / box.height - a.ratio)).toBeLessThan(0.01);
      }
    }
    expect(fitBox(1920, 1080, 9 / 16).height).toBeGreaterThan(fitBox(1920, 1080, 9 / 16).width);
  });
});

describe('WebGL context loss', () => {
  it('reports loss, and gives up only if the context is not restored in time', () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    const giveUp = vi.fn();
    const m = new ContextLossMonitor((lost) => states.push(lost), giveUp, 3000);
    m.handleLost();
    vi.advanceTimersByTime(2000);
    m.handleRestored();
    vi.advanceTimersByTime(5000);
    expect(giveUp).not.toHaveBeenCalled();
    expect(states).toEqual([true, false]);
    m.handleLost();
    vi.advanceTimersByTime(3001);
    expect(giveUp).toHaveBeenCalledTimes(1);
    m.dispose();
    vi.useRealTimers();
  });

  it('dispose cancels a pending give-up', () => {
    vi.useFakeTimers();
    const giveUp = vi.fn();
    const m = new ContextLossMonitor(() => {}, giveUp, 1000);
    m.handleLost();
    m.dispose();
    vi.advanceTimersByTime(5000);
    expect(giveUp).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('frame-rate governor', () => {
  it('steps quality down only after sustained slow frames', () => {
    const g = new FrameGovernor(42, 3);
    const onSlow = vi.fn();
    // binary-exact frame times so each measurement window is exactly one second
    // 2 slow seconds (32 fps), then a fast one (64 fps): no action
    for (let s = 0; s < 2; s++) for (let i = 0; i < 32; i++) g.sample(1 / 32, onSlow);
    for (let i = 0; i < 64; i++) g.sample(1 / 64, onSlow);
    expect(onSlow).not.toHaveBeenCalled();
    // 3 consecutive slow seconds: one step
    for (let s = 0; s < 3; s++) for (let i = 0; i < 32; i++) g.sample(1 / 32, onSlow);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });

  it('reports the measured rate once per second', () => {
    const g = new FrameGovernor();
    const readings: number[] = [];
    for (let i = 0; i < 129; i++) {
      const fps = g.sample(1 / 64, () => {});
      if (fps !== null) readings.push(fps);
    }
    expect(readings).toHaveLength(2);
    expect(readings[0]).toBe(64);
  });
});
