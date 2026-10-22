import { useSyncExternalStore } from 'react';
import { resolveReducedMotion, useSettings } from '../state/settings';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia?.(QUERY);
  if (!mq) return () => {};
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

export function systemPrefersReducedMotion(): boolean {
  return window.matchMedia?.(QUERY).matches ?? false;
}

export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, systemPrefersReducedMotion, () => false);
}

/** Effective reduced-motion flag (setting AUTO follows the OS preference). */
export function useReducedMotion(): boolean {
  const setting = useSettings((s) => s.reducedMotion);
  const system = useSystemReducedMotion();
  return resolveReducedMotion(setting, system);
}
