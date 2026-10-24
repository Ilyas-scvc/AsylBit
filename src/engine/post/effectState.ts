/**
 * Per-effect state of the post stack (a kaleidoscope's spin angle, a trails history), keyed
 * by effect id so two instances of the same effect never share it. State of effects that are
 * no longer rendered (removed, disabled, over the budget) is released on the next frame.
 */
export class EffectStates<T> {
  private readonly states = new Map<string, T>();

  constructor(
    private readonly create: (id: string) => T,
    private readonly release: (state: T) => void = () => {},
  ) {}

  get(id: string): T {
    let s = this.states.get(id);
    if (!s) {
      s = this.create(id);
      this.states.set(id, s);
    }
    return s;
  }

  has(id: string): boolean {
    return this.states.has(id);
  }

  /** Release the state of every id not in `ids`. */
  retain(ids: ReadonlySet<string>): void {
    for (const [id, s] of this.states) {
      if (!ids.has(id)) {
        this.release(s);
        this.states.delete(id);
      }
    }
  }

  clear(): void {
    for (const s of this.states.values()) this.release(s);
    this.states.clear();
  }

  values(): IterableIterator<T> {
    return this.states.values();
  }

  get size(): number {
    return this.states.size;
  }
}
