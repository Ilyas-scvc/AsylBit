/**
 * The user's disc artwork: upload, replace, remove, and keep it across visits.
 *
 * An uploaded image is checked (type, size), decoded and scaled down to at most
 * MAX_ARTWORK_PX on its long side, then kept as a canvas every renderer can turn into a texture
 * (the live stage, Export Studio, the export itself). The scaled copy is stored in IndexedDB —
 * images are far too large for localStorage and are never part of presets or share links.
 * Each new image gets a new id, so renderers free the old texture when it changes.
 *
 * Storage and decoding go through `ArtworkIO`, replaced by a fake in tests.
 */
import { create } from 'zustand';
import type { DiscArtwork } from '../engine/disc/settings';

export const MAX_ARTWORK_BYTES = 30 * 1024 * 1024;
export const MAX_ARTWORK_PX = 2048;
export const MIN_ARTWORK_PX = 16;
export const ARTWORK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'];
const EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

export interface DecodedArtwork {
  source: DiscArtwork['source'];
  width: number;
  height: number;
  /** the scaled copy that is stored */
  blob: Blob;
}

export interface StoredArtwork {
  blob: Blob;
  name: string;
}

export interface ArtworkIO {
  /** decode a file and scale it to ≤ MAX_ARTWORK_PX; rejects when the image cannot be read */
  decode(file: Blob): Promise<DecodedArtwork>;
  save(record: StoredArtwork | null): Promise<void>;
  load(): Promise<StoredArtwork | null>;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}

export interface ArtworkState {
  status: 'empty' | 'loading' | 'ready' | 'error';
  artwork: DiscArtwork | null;
  name: string | null;
  /** object URL of the stored copy, for the Inspector preview */
  previewUrl: string | null;
  error: string | null;
}

const EMPTY: ArtworkState = { status: 'empty', artwork: null, name: null, previewUrl: null, error: null };

export const useArtwork = create<ArtworkState>()(() => ({ ...EMPTY }));

// ---- browser implementation -------------------------------------------------------------

const DB_NAME = 'beatform-assets';
const STORE = 'artwork';
const KEY = 'disc';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const browserIO: ArtworkIO = {
  async decode(file) {
    const bitmap = await createImageBitmap(file);
    try {
      const k = Math.min(1, MAX_ARTWORK_PX / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * k));
      const height = Math.max(1, Math.round(bitmap.height * k));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (!g) throw new Error('2D CANVAS UNAVAILABLE');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('COULD NOT ENCODE THE IMAGE'))), 'image/webp', 0.92));
      return { source: canvas, width, height, blob };
    } finally {
      bitmap.close();
    }
  },
  async save(record) {
    await withStore<unknown>('readwrite', (s) => (record ? s.put(record, KEY) : s.delete(KEY)) as IDBRequest<unknown>);
  },
  async load() {
    const v = await withStore<unknown>('readonly', (s) => s.get(KEY));
    const r = v as Partial<StoredArtwork> | undefined;
    return r && r.blob instanceof Blob && typeof r.name === 'string' ? { blob: r.blob, name: r.name } : null;
  },
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
};

let io: ArtworkIO = browserIO;

/** Tests only: replace decoding / storage. */
export function setArtworkIO(next: ArtworkIO | null): void {
  io = next ?? browserIO;
}

// ---- actions -----------------------------------------------------------------------------

/** Latest request wins: an older upload that finishes later is dropped. */
let token = 0;
let counter = 0;

/** Why `file` cannot be used, or null when it may be. */
export function validateArtworkFile(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  const typed = file.type ? ARTWORK_TYPES.includes(file.type.toLowerCase()) : EXTENSIONS.test(file.name);
  if (!typed) return 'NOT A SUPPORTED IMAGE (PNG, JPEG, WEBP, GIF, AVIF, BMP)';
  if (file.size <= 0) return 'THE IMAGE FILE IS EMPTY';
  if (file.size > MAX_ARTWORK_BYTES) return `IMAGE TOO LARGE (MAX ${MAX_ARTWORK_BYTES / 2 ** 20} MB)`;
  return null;
}

function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 120) || 'ARTWORK';
}

function show(decoded: DecodedArtwork, name: string, error: string | null = null): void {
  const prev = useArtwork.getState().previewUrl;
  if (prev) io.revokeUrl(prev);
  counter++;
  useArtwork.setState({
    status: 'ready',
    artwork: { id: `art-${counter}-${decoded.width}x${decoded.height}`, source: decoded.source, width: decoded.width, height: decoded.height },
    name,
    previewUrl: io.createUrl(decoded.blob),
    error,
  });
}

/** Upload or replace the artwork. Resolves true when the new image is on the disc. */
export async function loadArtwork(file: File): Promise<boolean> {
  const invalid = validateArtworkFile(file);
  if (invalid) {
    // a bad pick never removes the image that is already on the disc
    useArtwork.setState({ error: invalid, status: useArtwork.getState().artwork ? 'ready' : 'error' });
    return false;
  }
  const mine = ++token;
  useArtwork.setState({ status: 'loading', error: null });
  let decoded: DecodedArtwork;
  try {
    decoded = await io.decode(file);
  } catch (err) {
    if (mine !== token) return false;
    console.warn('[BEAT//FORM] artwork could not be decoded', err);
    useArtwork.setState({ status: useArtwork.getState().artwork ? 'ready' : 'error', error: 'THE IMAGE COULD NOT BE READ' });
    return false;
  }
  if (mine !== token) return false;
  if (decoded.width < MIN_ARTWORK_PX || decoded.height < MIN_ARTWORK_PX) {
    useArtwork.setState({ status: useArtwork.getState().artwork ? 'ready' : 'error', error: `IMAGE TOO SMALL (MIN ${MIN_ARTWORK_PX} PX)` });
    return false;
  }
  const name = cleanName(file.name);
  let saveError: string | null = null;
  try {
    await io.save({ blob: decoded.blob, name });
  } catch (err) {
    console.warn('[BEAT//FORM] artwork could not be stored', err);
    saveError = 'SHOWN, BUT NOT SAVED FOR THE NEXT VISIT (BROWSER STORAGE UNAVAILABLE)';
  }
  if (mine !== token) return false;
  show(decoded, name, saveError);
  return true;
}

/** Remove the artwork: the procedural disc returns and the stored copy is deleted. */
export async function removeArtwork(): Promise<void> {
  token++;
  const prev = useArtwork.getState().previewUrl;
  if (prev) io.revokeUrl(prev);
  useArtwork.setState({ ...EMPTY });
  try {
    await io.save(null);
  } catch (err) {
    console.warn('[BEAT//FORM] stored artwork could not be deleted', err);
  }
}

/** Bring back the artwork stored by a previous visit (if any). */
export async function restoreArtwork(): Promise<void> {
  const mine = ++token;
  let stored: StoredArtwork | null;
  try {
    stored = await io.load();
  } catch (err) {
    console.warn('[BEAT//FORM] stored artwork could not be read', err);
    return;
  }
  if (!stored || mine !== token) return;
  try {
    const decoded = await io.decode(stored.blob);
    if (mine === token) show(decoded, stored.name);
  } catch (err) {
    console.warn('[BEAT//FORM] stored artwork could not be decoded', err);
  }
}

/** The image to put on the disc right now (renderers call this when they start). */
export function currentArtwork(): DiscArtwork | null {
  return useArtwork.getState().artwork;
}
