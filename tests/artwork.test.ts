/**
 * Disc artwork: upload, replace, remove, keep across visits. Decoding and IndexedDB are
 * replaced by a fake (ArtworkIO), so these tests check the logic — validation, which image
 * wins, what is stored, which preview URLs are released — not the browser APIs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadArtwork,
  MAX_ARTWORK_BYTES,
  removeArtwork,
  restoreArtwork,
  setArtworkIO,
  useArtwork,
  validateArtworkFile,
  type ArtworkIO,
  type DecodedArtwork,
  type StoredArtwork,
} from '../src/state/artwork';

class FakeIO implements ArtworkIO {
  stored: StoredArtwork | null = null;
  saves = 0;
  live = new Set<string>();
  revoked: string[] = [];
  failSave = false;
  /** per file name: decode delay (ms) / failure / size */
  delay: Record<string, number> = {};
  broken = new Set<string>();
  size: Record<string, [number, number]> = {};
  private n = 0;

  async decode(file: Blob): Promise<DecodedArtwork> {
    const name = (file as File).name ?? 'stored';
    if (this.delay[name]) await new Promise((r) => setTimeout(r, this.delay[name]));
    if (this.broken.has(name)) throw new Error('decode failed');
    const [width, height] = this.size[name] ?? [800, 600];
    return { source: { tag: name } as unknown as HTMLCanvasElement, width, height, blob: new Blob([`scaled:${name}`], { type: 'image/webp' }) };
  }
  async save(record: StoredArtwork | null) {
    if (this.failSave) throw new Error('QuotaExceededError');
    this.saves++;
    this.stored = record;
  }
  async load() {
    return this.stored;
  }
  createUrl() {
    const url = `blob:fake/${++this.n}`;
    this.live.add(url);
    return url;
  }
  revokeUrl(url: string) {
    this.live.delete(url);
    this.revoked.push(url);
  }
}

const png = (name: string, bytes = 100) => new File([new Uint8Array(bytes)], name, { type: 'image/png' });
let io: FakeIO;

beforeEach(async () => {
  io = new FakeIO();
  setArtworkIO(io);
  await removeArtwork();
  io.saves = 0;
  io.revoked = [];
});
afterEach(() => setArtworkIO(null));

describe('disc artwork', () => {
  it('upload: decoded, shown, stored, with a preview', async () => {
    expect(await loadArtwork(png('cover.png'))).toBe(true);
    const s = useArtwork.getState();
    expect(s.status).toBe('ready');
    expect(s.name).toBe('cover.png');
    expect(s.artwork).toMatchObject({ width: 800, height: 600 });
    expect(s.previewUrl && io.live.has(s.previewUrl)).toBe(true);
    expect(io.stored?.name).toBe('cover.png');
    expect(await io.stored!.blob.text()).toBe('scaled:cover.png'); // the scaled copy, not the original
  });

  it('replace: a new image id (renderers swap their texture), the old preview released', async () => {
    await loadArtwork(png('a.png'));
    const first = useArtwork.getState();
    await loadArtwork(png('b.png'));
    const second = useArtwork.getState();
    expect(second.artwork!.id).not.toBe(first.artwork!.id);
    expect(io.revoked).toContain(first.previewUrl);
    expect(io.live.size).toBe(1);
    expect(io.stored?.name).toBe('b.png');
  });

  it('remove: back to the procedural disc, the stored copy deleted, nothing leaked', async () => {
    await loadArtwork(png('a.png'));
    await removeArtwork();
    const s = useArtwork.getState();
    expect(s).toMatchObject({ status: 'empty', artwork: null, previewUrl: null, name: null });
    expect(io.stored).toBeNull();
    expect(io.live.size).toBe(0);
  });

  it('rejects files that are not images or are too large, keeping the current artwork', async () => {
    await loadArtwork(png('keep.png'));
    const kept = useArtwork.getState().artwork;
    expect(await loadArtwork(new File(['x'], 'notes.txt', { type: 'text/plain' }))).toBe(false);
    expect(useArtwork.getState().error).toMatch(/NOT A SUPPORTED IMAGE/);
    expect(useArtwork.getState().artwork).toBe(kept);
    expect(validateArtworkFile({ name: 'huge.png', type: 'image/png', size: MAX_ARTWORK_BYTES + 1 })).toMatch(/TOO LARGE/);
    expect(validateArtworkFile({ name: 'empty.png', type: 'image/png', size: 0 })).toMatch(/EMPTY/);
    expect(validateArtworkFile({ name: 'photo.JPG', type: '', size: 10 })).toBeNull();
    expect(validateArtworkFile({ name: 'clip.svg', type: 'image/svg+xml', size: 10 })).toMatch(/NOT A SUPPORTED/);
  });

  it('an image that cannot be decoded, or is tiny, is reported and changes nothing', async () => {
    await loadArtwork(png('keep.png'));
    const kept = useArtwork.getState().artwork;
    io.broken.add('bad.png');
    expect(await loadArtwork(png('bad.png'))).toBe(false);
    expect(useArtwork.getState()).toMatchObject({ status: 'ready', error: 'THE IMAGE COULD NOT BE READ' });
    io.size['dot.png'] = [8, 8];
    expect(await loadArtwork(png('dot.png'))).toBe(false);
    expect(useArtwork.getState().error).toMatch(/TOO SMALL/);
    expect(useArtwork.getState().artwork).toBe(kept);
    expect(io.stored?.name).toBe('keep.png');
  });

  it('the last choice wins when uploads overlap', async () => {
    io.delay['slow.png'] = 30;
    const slow = loadArtwork(png('slow.png'));
    const fast = loadArtwork(png('fast.png'));
    expect(await fast).toBe(true);
    expect(await slow).toBe(false);
    expect(useArtwork.getState().name).toBe('fast.png');
    expect(io.stored?.name).toBe('fast.png');
    expect(io.live.size).toBe(1);
  });

  it('remove during an upload cancels that upload', async () => {
    io.delay['slow.png'] = 20;
    const slow = loadArtwork(png('slow.png'));
    await removeArtwork();
    expect(await slow).toBe(false);
    expect(useArtwork.getState().artwork).toBeNull();
    expect(io.stored).toBeNull();
  });

  it('comes back on the next visit', async () => {
    io.stored = { blob: new Blob(['x']), name: 'saved.webp' };
    await restoreArtwork();
    expect(useArtwork.getState()).toMatchObject({ status: 'ready', name: 'saved.webp' });
  });

  it('still shows an image the browser could not store, and says so', async () => {
    io.failSave = true;
    expect(await loadArtwork(png('a.png'))).toBe(true);
    expect(useArtwork.getState().status).toBe('ready');
    expect(useArtwork.getState().error).toMatch(/NOT SAVED/);
  });
});
