// Lag (in samples) between a reference PCM segment and the exported audio, by normalized
// cross-correlation over ±50 ms. Both: f32le mono 48 kHz. 0 = sample-exact.
// usage: node audio-lag.mjs <reference.f32> <exported.f32>
import { readFileSync } from 'node:fs';
const load = (p) => { const b = readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const [ref, out] = process.argv.slice(2).map(load);
const n = Math.min(ref.length, out.length) - 4000;
const maxLag = 2400;
let best = 0, bestC = -Infinity;
const corr = (lag) => { let s = 0, ea = 0, eb = 0; for (let i = 2400; i < n; i += 1) { const a = ref[i], b = out[i + lag]; s += a * b; ea += a * a; eb += b * b; } return s / Math.sqrt(ea * eb); };
for (let lag = -maxLag; lag <= maxLag; lag += 8) { const c = corr(lag); if (c > bestC) { bestC = c; best = lag; } }
for (let lag = best - 8; lag <= best + 8; lag++) { const c = corr(lag); if (c > bestC) { bestC = c; best = lag; } }
let diff = 0, energy = 0; for (let i = 2400; i < n; i++) { const d = ref[i] - out[i]; diff += d * d; energy += ref[i] * ref[i]; }
console.log(`samples ref ${ref.length} out ${out.length}`);
console.log(`best lag ${best} samples (${(best / 48).toFixed(3)} ms), correlation ${bestC.toFixed(5)}`);
console.log(`residual at lag 0: ${(10 * Math.log10(diff / energy)).toFixed(1)} dB relative to signal`);
