/**
 * Integration with the real Mediabunny muxer (no mocks of the library): pre-encoded packets
 * are muxed into the export sinks, then cancelled, failed or finalized. The disk file is a
 * stand-in with FileSystemWritableFileStream semantics (writes go to a temporary copy,
 * close() replaces the file, abort() discards); the real browser stream is exercised by the
 * in-browser check (src/dev/exportChecks.ts).
 */
import * as mb from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { MemoryFileSink, OutputLimitError, TransactionalFileSink, type WriteChunk } from '../src/export/sinks';

const ORIGINAL = 'ORIGINAL FILE CONTENTS';
const AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
const PACKET = 4000;

class DiskFile {
  committed = new TextEncoder().encode(ORIGINAL);
  private swap = new Uint8Array(0);
  closeCalls = 0;
  abortCalls = 0;
  async write(c: WriteChunk) {
    const end = c.position + c.data.byteLength;
    if (end > this.swap.length) {
      const g = new Uint8Array(end);
      g.set(this.swap);
      this.swap = g;
    }
    this.swap.set(c.data, c.position);
  }
  async close() {
    this.closeCalls++;
    this.committed = this.swap;
  }
  async abort() {
    this.abortCalls++;
    this.swap = new Uint8Array(0);
  }
  get text() {
    return new TextDecoder().decode(this.committed);
  }
}

async function mux(stream: WritableStream, opts: { packets: number; container?: 'mp4' | 'webm'; maxPackets?: number; chunkSize?: number }) {
  const container = opts.container ?? 'mp4';
  const output = new mb.Output({
    format: container === 'webm' ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: 'reserve' }),
    target: new mb.StreamTarget(stream, { chunked: true, chunkSize: opts.chunkSize ?? 2 ** 16 }),
  });
  const video = new mb.EncodedVideoPacketSource(container === 'webm' ? 'vp9' : 'avc');
  output.addVideoTrack(video, { frameRate: 30, maximumPacketCount: opts.maxPackets ?? opts.packets + 16 });
  await output.start();
  const add = async (i: number) =>
    video.add(
      new mb.EncodedPacket(new Uint8Array(PACKET).fill(i & 255), i % 30 === 0 ? 'key' : 'delta', i / 30, 1 / 30),
      i === 0 ? { decoderConfig: container === 'webm' ? { codec: 'vp09.00.10.08', codedWidth: 64, codedHeight: 64 } : { codec: 'avc1.640028', codedWidth: 64, codedHeight: 64, description: AVCC } } : undefined,
    );
  return { output, add };
}

async function readBack(bytes: Uint8Array) {
  const input = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const stats = await track!.computePacketStats();
  const duration = await input.computeDuration();
  const format = (await input.getFormat()).name;
  input.dispose();
  return { packets: stats.packetCount, duration, format };
}

describe('TransactionalFileSink with the real muxer', () => {
  it('Output.cancel() closes the stream it was given (why a raw file stream would be committed)', async () => {
    let closed = 0;
    const raw = new WritableStream({ write() {}, close: () => void closed++ });
    const { output, add } = await mux(raw, { packets: 10 });
    for (let i = 0; i < 10; i++) await add(i);
    await output.cancel();
    expect(closed).toBe(1);
  });

  it('cancel after real writes leaves the existing file untouched', async () => {
    const file = new DiskFile();
    const sink = new TransactionalFileSink(file);
    const { output, add } = await mux(sink.stream, { packets: 200 });
    for (let i = 0; i < 120; i++) await add(i);
    expect(sink.bytes).toBeGreaterThan(80 * PACKET); // data really was written to the temporary copy
    await output.cancel(); // the library closes the stream …
    expect(sink.state).toBe('open'); // … which commits nothing
    await sink.abort();
    expect(file.closeCalls).toBe(0);
    expect(file.abortCalls).toBe(1);
    expect(file.text).toBe(ORIGINAL);
  });

  it('a failed finalize (reserved header too small) leaves the existing file untouched', async () => {
    const file = new DiskFile();
    const sink = new TransactionalFileSink(file);
    const { output, add } = await mux(sink.stream, { packets: 120, maxPackets: 10 });
    let err: unknown = null;
    try {
      for (let i = 0; i < 120; i++) await add(i);
      await output.finalize();
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    await sink.abort();
    expect(file.closeCalls).toBe(0);
    expect(file.text).toBe(ORIGINAL);
  });

  it('commit after a real finalize writes a complete, readable MP4', async () => {
    const file = new DiskFile();
    const sink = new TransactionalFileSink(file);
    const { output, add } = await mux(sink.stream, { packets: 90 });
    for (let i = 0; i < 90; i++) await add(i);
    await output.finalize();
    expect(file.text).toBe(ORIGINAL); // still the old file until commit
    await sink.commit();
    expect(file.closeCalls).toBe(1);
    const info = await readBack(file.committed);
    expect(info.packets).toBe(90);
    expect(info.duration).toBeCloseTo(3, 2);
    expect(new TextDecoder().decode(file.committed.subarray(4, 8))).toBe('ftyp');
  });
});

describe('MemoryFileSink with the real muxer', () => {
  it('counts the real size while packets are being added, not only after finalize', async () => {
    const sink = new MemoryFileSink(64 * 2 ** 20);
    const { output, add } = await mux(sink.stream, { packets: 300 });
    for (let i = 0; i < 300; i++) await add(i);
    // 'reserve' + chunked writes: everything but the last unfinished chunk is already counted
    expect(sink.size).toBeGreaterThan(300 * PACKET - 2 ** 17);
    await output.finalize();
    const blob = sink.toBlob('video/mp4');
    const info = await readBack(new Uint8Array(await blob.arrayBuffer()));
    expect(info.packets).toBe(300);
    expect(info.duration).toBeCloseTo(10, 2);
    // fast start: the movie header precedes the media data
    const head = new TextDecoder('latin1').decode(new Uint8Array(await blob.slice(0, 2 ** 16).arrayBuffer()));
    expect(head.indexOf('moov')).toBeGreaterThan(0);
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat'));
  });

  it('a WebM (sizes rewritten at the end) round-trips through the sink', async () => {
    const sink = new MemoryFileSink(64 * 2 ** 20);
    const { output, add } = await mux(sink.stream, { packets: 60, container: 'webm' });
    for (let i = 0; i < 60; i++) await add(i);
    await output.finalize();
    const info = await readBack(new Uint8Array(await sink.toBlob('video/webm').arrayBuffer()));
    expect(info.packets).toBe(60);
    expect(info.duration).toBeCloseTo(2, 1);
  });

  it('refuses to grow past the limit and the muxer surfaces the error', async () => {
    const limit = 50 * PACKET;
    const sink = new MemoryFileSink(limit);
    const { output, add } = await mux(sink.stream, { packets: 300 });
    let err: unknown = null;
    try {
      for (let i = 0; i < 300; i++) await add(i);
      await output.finalize();
    } catch (e) {
      err = e;
    }
    expect(sink.limitError).toBeInstanceOf(OutputLimitError);
    expect(err).not.toBeNull();
    expect(sink.size).toBeLessThanOrEqual(limit);
    await output.cancel().catch(() => {});
  });
});
