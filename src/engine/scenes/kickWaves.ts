/**
 * Kick ring waves of REACTIVE MESH: a small pool of independent waves, each with its own age
 * and amplitude, so a new kick adds an impulse instead of restarting the surface.
 *
 *   level = amp · attack(t) · decay(t) · life(t) · exit(age) · retire
 *
 *   t      real seconds since the kick (attack and decay keep the same feel at any SPEED)
 *   age    wave time (t scaled by SPEED): the ring sits at radius age · RING_SPEED and fades
 *          out as it leaves the mesh, exactly like the single ring before
 *
 * Everything is a closed-form function of t / age, so the result does not depend on the frame
 * rate (only the spawn is quantised to the frame on which the kick is reported) and exports
 * reproduce it. Per frame: step() the running waves first, then hit() — a new wave starts at
 * age 0 on the frame that reports it and rises on the following frames on the same real-time
 * curve at any frame rate. Pure — no three.js — so it can be tested directly.
 */

export const KICK_WAVE = {
  /** ring travel in mesh radii per second of wave time */
  ringSpeed: 0.9,
  /** ring width (gaussian falloff factor across the radius) */
  sharpness: 7,
  /** rise of a new wave, s (90 % after ≈ 45 ms) */
  attack: 0.055,
  /** exponential fade time constant, s */
  decay: 1.1,
  /** hard end of a wave's life, s (eased out over [lifeFade, life]) */
  lifeFade: 1.6,
  life: 3,
  /** fade-out by wave age as the ring leaves the mesh */
  exitStart: 0.6,
  exitEnd: 1.2,
  /** kicks closer together than this reinforce the newest wave instead of adding one */
  merge: 0.06,
  /** live waves; one more retires the weakest over `retire` seconds */
  capacity: 16,
  /** uniform slots (live + retiring): a spawn never has to drop a visible wave */
  slots: 24,
  retire: 0.12,
  /** largest amplitude of one wave */
  maxAmp: 1.2,
  /** below this a kick adds nothing (KICK IMPACT 0, closed noise gate) */
  minAmp: 0.01,
  /** summed rings: linear up to `knee`, then eased toward `ceiling` */
  knee: 0.9,
  ceiling: 1.5,
} as const;

interface Wave {
  t: number;
  age: number;
  amp: number;
  /** seconds since this wave started retiring (-1: not retiring) */
  retiring: number;
}

const smooth01 = (x: number) => {
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return c * c * (3 - 2 * c);
};
const smoothstep = (a: number, b: number, x: number) => smooth01((x - a) / (b - a));

/** Summed ring deformation with a soft ceiling, so stacked waves never grow without bound. */
export function softLimit(sum: number): number {
  const { knee, ceiling } = KICK_WAVE;
  if (sum <= knee) return sum;
  const r = ceiling - knee;
  return knee + r * Math.tanh((sum - knee) / r);
}

export class KickWaves {
  private readonly waves: Wave[] = [];

  get count(): number {
    return this.waves.length;
  }

  /** Waves that are not retiring. */
  get live(): number {
    let n = 0;
    for (const w of this.waves) if (w.retiring < 0) n++;
    return n;
  }

  /** A kick of `strength` (already scaled by KICK IMPACT and the gate). */
  hit(strength: number): void {
    const amp = Math.min(KICK_WAVE.maxAmp, Math.max(0, strength));
    if (amp < KICK_WAVE.minAmp) return;
    const newest = this.waves[this.waves.length - 1];
    if (newest && newest.retiring < 0 && newest.t < KICK_WAVE.merge) {
      // a flam / double trigger: strengthen the wave that is still rising
      newest.amp = Math.min(KICK_WAVE.maxAmp, Math.max(newest.amp, amp) + 0.25 * Math.min(newest.amp, amp));
      return;
    }
    if (this.live >= KICK_WAVE.capacity) {
      // too many at once (slow SPEED, dense kicks): the weakest fades out quickly, never pops
      let weakest: Wave | null = null;
      for (const w of this.waves) if (w.retiring < 0 && (!weakest || this.level(w) < this.level(weakest))) weakest = w;
      if (weakest) weakest.retiring = 0;
    }
    if (this.waves.length >= KICK_WAVE.slots) {
      // only reachable with more spawns than one per `merge` interval: drop the faintest
      let faintest = 0;
      for (let i = 1; i < this.waves.length; i++) if (this.level(this.waves[i]) < this.level(this.waves[faintest])) faintest = i;
      this.waves.splice(faintest, 1);
    }
    this.waves.push({ t: 0, age: 0, amp, retiring: -1 });
  }

  /** Advance by `dt` real seconds; `rate` scales wave time (SPEED). */
  step(dt: number, rate: number): void {
    const d = Math.max(0, dt);
    for (const w of this.waves) {
      w.t += d;
      w.age += d * Math.max(0, rate);
      if (w.retiring >= 0) w.retiring += d;
    }
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      // removed only where its level has already reached exactly 0
      if (w.t >= KICK_WAVE.life || w.age >= KICK_WAVE.exitEnd || (w.retiring >= 0 && w.retiring >= KICK_WAVE.retire)) this.waves.splice(i, 1);
    }
  }

  /** Visible amplitude of a wave now. */
  level(w: Wave): number {
    const k = KICK_WAVE;
    const attack = smooth01(w.t / k.attack);
    const decay = Math.exp(-w.t / k.decay) * (1 - smoothstep(k.lifeFade, k.life, w.t));
    const exit = 1 - smoothstep(k.exitStart, k.exitEnd, w.age);
    const retire = w.retiring < 0 ? 1 : 1 - smooth01(w.retiring / k.retire);
    return w.amp * attack * decay * exit * retire;
  }

  /** Write [ring radius, amplitude] pairs for the shader; returns how many were written. */
  write(out: Float32Array, scale = 1): number {
    const n = Math.min(this.waves.length, out.length >> 1);
    for (let i = 0; i < n; i++) {
      const w = this.waves[i];
      out[i * 2] = w.age * KICK_WAVE.ringSpeed;
      out[i * 2 + 1] = this.level(w) * scale;
    }
    return n;
  }

  /** The deformation the shader adds at mesh radius `radial` (same formula, for tests). */
  sample(radial: number, scale = 1): number {
    let sum = 0;
    for (const w of this.waves) {
      const d = (radial - w.age * KICK_WAVE.ringSpeed) * KICK_WAVE.sharpness;
      sum += Math.exp(-d * d) * this.level(w) * scale;
    }
    return softLimit(sum);
  }

  /** Amplitudes of all waves, newest last (tests / diagnostics). */
  levels(): number[] {
    return this.waves.map((w) => this.level(w));
  }

  ages(): number[] {
    return this.waves.map((w) => w.t);
  }

  clear(): void {
    this.waves.length = 0;
  }
}
