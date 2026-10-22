/** One-pole smoothing helpers that are independent of the frame rate. */

/** Retention coefficient for a time constant `tau` (seconds) over a step of `dt` seconds. */
export function retention(tau: number, dt: number): number {
  if (tau <= 0) return 0;
  return Math.exp(-dt / tau);
}

/** Moves `current` toward `target` using `attack` when rising and `release` when falling. */
export function attackRelease(current: number, target: number, dt: number, attack: number, release: number): number {
  const k = retention(target > current ? attack : release, dt);
  return target + (current - target) * k;
}

/** Exponential decay toward zero. */
export function decay(value: number, dt: number, tau: number): number {
  const v = value * retention(tau, dt);
  return v < 1e-4 ? 0 : v;
}

/**
 * Critically-damped-ish spring used for organic scale pulses: snappy attack, smooth
 * return to rest without the jitter a raw envelope would produce.
 */
export class Spring {
  value: number;
  velocity = 0;

  constructor(
    initial: number,
    public stiffness = 220,
    public damping = 22,
  ) {
    this.value = initial;
  }

  step(target: number, dt: number): number {
    // Sub-step to stay stable during dropped frames.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const force = -this.stiffness * (this.value - target) - this.damping * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  reset(value: number): void {
    this.value = value;
    this.velocity = 0;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
