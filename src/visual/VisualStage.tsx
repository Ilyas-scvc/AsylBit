import { Component, lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Canvas2DRenderer } from './fallback/Canvas2DRenderer';
import { fallBackTo2D, useRuntime } from './runtime';

const WebGLStage = lazy(() => import('./WebGLStage'));

/** If the WebGL chunk itself cannot load (offline, blocked), keep the site working in 2D. */
class ChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    fallBackTo2D('WEBGL MODULE FAILED TO LOAD');
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Hosts the active renderer and pauses it while the stage is scrolled out of view. During
 * a video export the renderer is laid out at the exact export resolution and scaled down
 * to fit the stage (the canvas itself is not remounted).
 */
export function VisualStage() {
  const renderer = useRuntime((s) => s.renderer);
  const visible = useRuntime((s) => s.stageVisible);
  const exportConfig = useRuntime((s) => s.exportConfig);
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => useRuntime.setState({ stageVisible: entry.isIntersecting }), { threshold: 0.02 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !exportConfig) return;
    const fit = () => setScale(Math.min(el.clientWidth / exportConfig.width, el.clientHeight / exportConfig.height) * 0.94);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [exportConfig]);

  const innerStyle: CSSProperties | undefined = exportConfig
    ? {
        right: 'auto',
        bottom: 'auto',
        left: '50%',
        top: '50%',
        width: exportConfig.width,
        height: exportConfig.height,
        transform: `translate(-50%, -50%) scale(${scale})`,
      }
    : undefined;

  return (
    <div className="stage" ref={ref} data-renderer={renderer}>
      <div className={`stage-inner ${exportConfig ? 'is-export' : ''}`} style={innerStyle}>
        {renderer === 'webgl' ? (
          <ChunkBoundary>
            <Suspense fallback={null}>
              <WebGLStage active={visible} />
            </Suspense>
          </ChunkBoundary>
        ) : (
          <Canvas2DRenderer active={visible || !!exportConfig} />
        )}
      </div>
    </div>
  );
}
