import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { analysisHub } from '../audio/analysis/AnalysisHub';
import { useSettings } from '../state/settings';
import { PulseObject } from './modes/PulseObject';
import { RadialSpectrum } from './modes/RadialSpectrum';
import { WaveField } from './modes/WaveField';
import { effectiveDetail, maxDprFor, useRuntime } from './runtime';
import { useReducedMotion } from './useReducedMotion';

/** Runs the shared analysis step before any mode reads the frame. */
function HubTicker() {
  useFrame(() => analysisHub.tick(performance.now()), -10);
  return null;
}

function Background() {
  const bg = useSettings((s) => s.background);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    scene.background = new THREE.Color(bg);
  }, [bg, scene]);
  return null;
}

/**
 * Measures frame times. With quality on AUTO it steps the pixel ratio down, then the
 * geometry detail, when the device cannot hold a smooth frame rate.
 */
function PerformanceGovernor() {
  const setDpr = useThree((s) => s.setDpr);
  const acc = useRef({ frames: 0, time: 0, slowSeconds: 0 });
  useFrame((_, delta) => {
    const a = acc.current;
    a.frames++;
    a.time += delta;
    if (a.time < 1) return;
    const fps = a.frames / a.time;
    a.frames = 0;
    a.time = 0;
    const rt = useRuntime.getState();
    useRuntime.setState({ fps: Math.round(fps) });
    if (useSettings.getState().quality !== 'auto' || rt.exportConfig || document.hidden) return;
    a.slowSeconds = fps < 42 ? a.slowSeconds + 1 : 0;
    if (a.slowSeconds >= 3) {
      a.slowSeconds = 0;
      if (rt.dpr > 1.01) {
        const dpr = Math.max(1, rt.dpr - 0.25);
        useRuntime.setState({ dpr });
        setDpr(dpr);
      } else if (rt.autoDetail === 'high') {
        useRuntime.setState({ autoDetail: 'low', dpr: Math.min(rt.dpr, maxDprFor('low')) });
      }
    }
  });
  return null;
}

export function Scene() {
  const mode = useSettings((s) => s.mode);
  const quality = useSettings((s) => s.quality);
  const autoDetail = useRuntime((s) => s.autoDetail);
  const reducedMotion = useReducedMotion();
  const detail = effectiveDetail(quality, autoDetail);
  return (
    <>
      <HubTicker />
      <Background />
      <PerformanceGovernor />
      {mode === 'pulse' && <PulseObject key="pulse" detail={detail} reducedMotion={reducedMotion} />}
      {mode === 'radial' && <RadialSpectrum key="radial" detail={detail} reducedMotion={reducedMotion} />}
      {mode === 'wave' && <WaveField key="wave" detail={detail} reducedMotion={reducedMotion} />}
    </>
  );
}
