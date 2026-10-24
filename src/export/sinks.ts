/**
 * Where an export's bytes go. Both sinks sit behind a Mediabunny StreamTarget, which writes
 * `{ type: 'write', data, position }` chunks into a WritableStream.
 *
 * TransactionalFileSink — writing straight to a file picked by the user. Mediabunny closes
 * its stream on success *and* on cancel / failed finalize, and closing a
 * FileSystemWritableFileStream commits it: a cancelled export would replace the user's file
 * with a partial video. So Mediabunny gets a proxy stream whose close() commits nothing; the
 * real file stream is closed only by commit() after a fully successful export and aborted
 * otherwise. The browser writes into a temporary file until then, so an existing file stays
 * untouched on cancel and error.
 *
 * MemoryFileSink — keeping the result in memory for a download. Every byte the muxer writes
 * is counted here as it arrives, so the size limit is enforced on real data, not an estimate.
 * Data is kept as Blob parts (patched by reference when the muxer rewrites the header), so
 * the final Blob needs no extra copy.
 */

export interface WriteChunk {
  type: 'write';
  data: Uint8Array<ArrayBuffer>;
  position: number;
}

/** The part of FileSystemWritableFileStream that the sink uses. */
export interface WritableFileLike {
  write(chunk: WriteChunk): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

function asChunk(chunk: unknown, appendAt: number): WriteChunk {
  if (chunk instanceof Uint8Array) return { type: 'write', data: chunk as Uint8Array<ArrayBuffer>, position: appendAt };
  const c = chunk as Partial<WriteChunk>;
  if (c && c.type === 'write' && c.data instanceof Uint8Array && typeof c.position === 'number') return c as WriteChunk;
  throw new TypeError('Unsupported chunk written to the export sink');
}

export class OutputLimitError extends Error {
  constructor(readonly limitBytes: number) {
    const size = limitBytes >= 2 ** 30 ? `${(limitBytes / 2 ** 30).toFixed(1)} GB` : limitBytes >= 2 ** 20 ? `${Math.round(limitBytes / 2 ** 20)} MB` : `${Math.round(limitBytes / 1024)} KB`;
    super(`THE VIDEO GREW PAST THE IN-MEMORY LIMIT (${size}) — USE "WRITE TO DISK" OR A SHORTER RANGE`);
    this.name = 'OutputLimitError';
  }
}

export type FileSinkState = 'open' | 'committing' | 'committed' | 'aborted';

export class TransactionalFileSink {
  readonly stream: WritableStream<unknown>;
  /** bytes written so far (end of the furthest write) */
  bytes = 0;
  private _state: FileSinkState = 'open';

  constructor(private readonly file: WritableFileLike) {
    this.stream = new WritableStream<unknown>({
      write: async (chunk) => {
        if (this._state !== 'open') throw new Error(`Export file is ${this._state}`);
        const c = asChunk(chunk, this.bytes);
        await this.file.write(c);
        this.bytes = Math.max(this.bytes, c.position + c.data.byteLength);
      },
      // Mediabunny closes the stream on success, cancel and failure alike: never commit here.
      close: () => {},
      abort: (reason) => this.abort(reason),
    });
  }

  get state(): FileSinkState {
    return this._state;
  }

  /** Make the written file permanent. The only call that replaces the file on disk. */
  async commit(): Promise<void> {
    if (this._state !== 'open') throw new Error(`Cannot save: export file is ${this._state}`);
    this._state = 'committing';
    try {
      await this.file.close();
      this._state = 'committed';
    } catch (err) {
      this._state = 'aborted';
      throw new Error(`COULD NOT SAVE THE FILE — ${err instanceof Error ? err.message : String(err)}`.toUpperCase());
    }
  }

  /** Discard everything written; the file on disk keeps its previous contents. Idempotent. */
  async abort(reason?: unknown): Promise<void> {
    if (this._state !== 'open') return;
    this._state = 'aborted';
    try {
      await this.file.abort(reason);
    } catch (err) {
      // the stream is already unusable (e.g. errored); the original file was never replaced
      console.warn('[BEAT//FORM] aborting the export file failed', err);
    }
  }
}

export class MemoryFileSink {
  readonly stream: WritableStream<unknown>;
  /** bytes held (end of the furthest write) */
  size = 0;
  private parts: Blob[] = [];
  private overflow: OutputLimitError | null = null;

  constructor(readonly limitBytes: number) {
    this.stream = new WritableStream<unknown>({
      write: (chunk) => this.write(asChunk(chunk, this.size)),
    });
  }

  /** Set once a write would have crossed the limit; the data beyond it was not kept. */
  get limitError(): OutputLimitError | null {
    return this.overflow;
  }

  private write({ data, position }: WriteChunk): void {
    const end = position + data.byteLength;
    if (end > this.limitBytes) {
      this.overflow ??= new OutputLimitError(this.limitBytes);
      throw this.overflow;
    }
    const piece = new Blob([data.slice()]); // copy: the muxer reuses its chunk buffers
    if (position === this.size) {
      this.parts.push(piece);
    } else if (position > this.size) {
      this.parts.push(new Blob([new Uint8Array(position - this.size)]), piece);
    } else {
      // rewrite of earlier bytes (header / sizes at finalize): splice by reference
      const whole = new Blob(this.parts);
      this.parts = [whole.slice(0, position), piece];
      if (end < this.size) this.parts.push(whole.slice(end));
    }
    this.size = Math.max(this.size, end);
  }

  toBlob(type: string): Blob {
    return new Blob(this.parts, { type });
  }

  discard(): void {
    this.parts = [];
  }
}
