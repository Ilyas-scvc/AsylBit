/**
 * Immersive mode (HIDE UI): only the visualizer stays on screen. A "SHOW UI" control
 * appears when the pointer reaches the top-right corner, on any touch (phones), or when
 * it receives keyboard focus; H and Esc restore the UI as well.
 */
import { useEffect, useRef, useState } from 'react';
import { inRestoreCorner, useUi } from '../state/ui';

export function ImmersiveRestore() {
  const hidden = useUi((s) => s.hidden);
  const showUi = useUi((s) => s.showUi);
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!hidden) {
      setVisible(false);
      document.documentElement.classList.remove('cursor-idle');
      return;
    }
    const reveal = (ms: number) => {
      setVisible(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setVisible(false), ms);
    };
    let idle: number | undefined;
    const wake = () => {
      document.documentElement.classList.remove('cursor-idle');
      window.clearTimeout(idle);
      idle = window.setTimeout(() => document.documentElement.classList.add('cursor-idle'), 2500);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        wake();
        if (inRestoreCorner(e.clientX, e.clientY, window.innerWidth)) reveal(2500);
      }
    };
    const onTouch = () => reveal(4000);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('touchstart', onTouch, { passive: true });
    wake();
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('touchstart', onTouch);
      window.clearTimeout(timer.current);
      window.clearTimeout(idle);
      document.documentElement.classList.remove('cursor-idle');
    };
  }, [hidden]);

  if (!hidden) return null;
  return (
    <button type="button" className={`immersive-restore ${visible ? 'is-visible' : ''}`} onClick={showUi} onFocus={() => setVisible(true)} aria-label="Show UI (H or Esc)">
      SHOW UI <span className="dim">H / ESC</span>
    </button>
  );
}
