/**
 * The React Three Fiber stage. Loaded lazily so the page, CTA and player paint before the
 * three.js bundle arrives.
 */
import { Component, useEffect, useRef, type ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { Scene } from './Scene';
import { fallBackTo2D, setStageCanvas, useRuntime } from './runtime';

// Colours are authored in sRGB hex and written straight to an sRGB canvas: no conversion.
THREE.ColorManagement.enabled = false;

const CONTEXT_RESTORE_TIMEOUT = 3000;

class WebGLErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[BEAT//FORM] WebGL renderer failed, switching to Canvas 2D', error);
    fallBackTo2D('WEBGL RENDERER ERROR');
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function WebGLCanvas({ active }: { active: boolean }) {
  const dpr = useRuntime((s) => s.dpr);
  const exporting = useRuntime((s) => s.exportConfig !== null);
  const lostTimer = useRef<number | undefined>(undefined);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      window.clearTimeout(lostTimer.current);
      cleanup.current?.();
      setStageCanvas(null);
    },
    [],
  );

  return (
    <Canvas
      flat
      linear
      dpr={exporting ? 1 : dpr}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: false }}
      camera={{ fov: 35, near: 0.1, far: 100, position: [0, 0, 7] }}
      frameloop={active || exporting ? 'always' : 'never'}
      resize={{ offsetSize: true, debounce: { scroll: 50, resize: 30 } }}
      onCreated={({ gl }) => {
        const canvas = gl.domElement;
        canvas.setAttribute('aria-hidden', 'true');
        setStageCanvas(canvas);
        const onLost = (e: Event) => {
          e.preventDefault();
          useRuntime.setState({ contextLost: true });
          window.clearTimeout(lostTimer.current);
          lostTimer.current = window.setTimeout(() => {
            if (useRuntime.getState().contextLost) fallBackTo2D('WEBGL CONTEXT LOST');
          }, CONTEXT_RESTORE_TIMEOUT);
        };
        const onRestored = () => {
          window.clearTimeout(lostTimer.current);
          useRuntime.setState({ contextLost: false });
        };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        cleanup.current = () => {
          canvas.removeEventListener('webglcontextlost', onLost);
          canvas.removeEventListener('webglcontextrestored', onRestored);
        };
      }}
    >
      <Scene />
    </Canvas>
  );
}

export default function WebGLStage({ active }: { active: boolean }) {
  return (
    <WebGLErrorBoundary>
      <WebGLCanvas active={active} />
    </WebGLErrorBoundary>
  );
}
