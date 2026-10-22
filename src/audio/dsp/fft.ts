/**
 * Iterative in-place radix-2 FFT with precomputed twiddle and bit-reversal tables.
 * Allocation-free after construction, so it can run inside tight analysis loops.
 */
export class FFT {
  readonly size: number;
  readonly re: Float64Array;
  readonly im: Float64Array;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.cosTable = new Float64Array(size / 2);
    this.sinTable = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >>> b) & 1);
      this.reverse[i] = r;
    }
  }

  /** Forward transform of the current contents of `re` / `im`. */
  transform(): void {
    const { re, im, size, reverse, cosTable, sinTable } = this;
    for (let i = 0; i < size; i++) {
      const j = reverse[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >>> 1;
      const step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < half; k++) {
          const tw = k * step;
          const wr = cosTable[tw];
          const wi = sinTable[tw];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  /**
   * Windowed real-input transform. Reads `size` samples from `input` starting at `offset`
   * (zero-padding outside the array) and writes |X[k]| for k = 0..size/2 into `out`.
   */
  magnitudes(input: Float32Array, offset: number, window: Float32Array, out: Float32Array): void {
    const { re, im, size } = this;
    const n = input.length;
    for (let i = 0; i < size; i++) {
      const idx = offset + i;
      re[i] = idx >= 0 && idx < n ? input[idx] * window[i] : 0;
      im[i] = 0;
    }
    this.transform();
    const bins = size / 2;
    for (let k = 0; k <= bins && k < out.length; k++) {
      out[k] = Math.hypot(re[k], im[k]);
    }
  }
}

export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

/** Blackman window with the same coefficients the Web Audio AnalyserNode uses. */
export function blackmanWindow(size: number): Float32Array {
  const a = 0.16;
  const a0 = (1 - a) / 2;
  const a1 = 0.5;
  const a2 = a / 2;
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (2 * Math.PI * i) / size;
    w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x);
  }
  return w;
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
