// AV sync check for an export of the built-in TEST PATTERN (120 BPM) with brightness
// modulated by KICK: for every known kick, finds the frame where the brightness flash starts
// and reports when that frame is shown relative to the kick. See README → "Как повторить проверку".
// (Audio alignment is checked separately and sample-exactly by audio-lag.mjs.)
// usage: node av-sync.mjs <yavg.txt> <segmentStart> <fps>
import { readFileSync } from 'node:fs';

const [yavgPath, startArg, fpsArg] = process.argv.slice(2);
const start = Number(startArg);
const fps = Number(fpsArg);
// kick times of synthesizeTestPattern(sampleRate, 120) — src/audio/dsp/testPattern.ts
const KICKS = [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 16, 16.75, 17, 17.5, 18, 18.75, 19, 19.5, 20, 20.75, 21, 21.5, 22, 22.75, 23, 23.5];

const yavg = [...readFileSync(yavgPath, 'utf8').matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
const duration = yavg.length / fps;
const expected = KICKS.map((k) => k - start).filter((t) => t >= 0 && t < duration - 0.2);

let worstMs = 0;
let sumMs = 0;
const rows = expected.map((t) => {
  // the flash starts on the frame with the largest luma jump within [-2, +4] frames of the kick
  const n0 = Math.max(1, Math.floor(t * fps) - 2);
  const n1 = Math.min(yavg.length - 1, Math.ceil(t * fps) + 4);
  let frame = -1;
  let jump = 0;
  for (let n = n0; n <= n1; n++) {
    if (yavg[n] - yavg[n - 1] > jump) {
      jump = yavg[n] - yavg[n - 1];
      frame = n;
    }
  }
  // when that frame appears on screen relative to the sound (negative = slightly early)
  const ms = (frame / fps - t) * 1000;
  worstMs = Math.max(worstMs, Math.abs(ms));
  sumMs += ms;
  return `${t.toFixed(3).padStart(7)} s  flash frame ${String(frame).padStart(5)} (nearest ${String(Math.round(t * fps)).padStart(5)})  shown ${ms >= 0 ? '+' : ''}${ms.toFixed(1)} ms  ΔY ${jump.toFixed(1)}`;
});
console.log(rows.join('\n'));
console.log(`\nframes ${yavg.length}, kicks checked ${expected.length}`);
console.log(`flash vs kick: mean ${(sumMs / expected.length).toFixed(1)} ms, worst |${worstMs.toFixed(1)}| ms (one frame = ${(1000 / fps).toFixed(1)} ms)`);
