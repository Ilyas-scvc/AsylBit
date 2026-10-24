import { Component, lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { fitBox, PREVIEW_ASPECTS, useUi } from '../state/ui';
import { Canvas2DRenderer } from './fallback/Canvas2DRenderer';
import { fallBackTo2D, useRuntime } from './runtime';

const WebGLStage = lazy(() => import('./WebGLStage'));

/** If the WebGL chunk itself cannot load (offline, blocked), keep the site working in 2D. */
class ChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[BEAT//FORM] stage failed', error);
    fallBackTo2D('WEBGL MODULE FAILED');
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Hosts the active renderer and pauses it while the stage is scrolled out of view. The
 * "preview frame" letterboxes the canvas to the export aspect ratio; the legacy real-time
 * recorder lays the canvas out at its exact pixel size and scales it to fit.
 */
export function VisualStage() {
  const renderer = useRuntime((s) => s.renderer);
  const visible = useRuntime((s) => s.stageVisible);
  const exportConfig = useRuntime((s) => s.exportConfig);
  const aspect = useUi((s) => s.previewAspect);
  const safeZones = useUi((s) => s.safeZones);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 1, h: 1 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(([e]) => useRuntime.setState({ stageVisible: e.isIntersecting }), { threshold: 0.02 }) : null;
    io?.observe(el);
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => {
      io?.disconnect();
      ro.disconnect();
    };
  }, []);

  const ratio = PREVIEW_ASPECTS.find((a) => a.id === aspect)?.ratio ?? null;
  let innerStyle: CSSProperties | undefined;
  let framed = false;
  if (exportConfig) {
    const s = Math.min(box.w / exportConfig.width, box.h / exportConfig.height) * 0.94;
    innerStyle = { right: 'auto', bottom: 'auto', left: '50%', top: '50%', width: exportConfig.width, height: exportConfig.height, transform: `translate(-50%, -50%) scale(${s})` };
    framed = true;
  } else if (ratio) {
    const fit = fitBox(box.w, box.h, ratio);
    innerStyle = { right: 'auto', bottom: 'auto', left: '50%', top: '50%', width: fit.width, height: fit.height, transform: 'translate(-50%, -50%)' };
    framed = true;
  }

  return (
    <div className="stage" ref={ref} data-renderer={renderer} data-frame={framed ? aspect : 'full'}>
      <div className={`stage-inner ${framed ? 'is-framed' : ''}`} style={innerStyle}>
        {renderer === 'webgl' ? (
          <ChunkBoundary>
            <Suspense fallback={null}>
              <WebGLStage active={visible} />
            </Suspense>
          </ChunkBoundary>
        ) : (
          <Canvas2DRenderer active={visible || !!exportConfig} />
        )}
        {framed && !exportConfig && aspect === '9:16' && safeZones && (
          <div className="safe-zones" aria-hidden="true">
            <span className="sz-top">SAFE ZONE · PLATFORM UI</span>
            <span className="sz-right" />
            <span className="sz-bottom">CAPTION / BUTTONS</span>
          </div>
        )}
      </div>
    </div>
  );
}
