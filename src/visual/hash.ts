/** Deterministic hash → [0, 1). Used for stable per-vertex/particle variation. */
export function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}
