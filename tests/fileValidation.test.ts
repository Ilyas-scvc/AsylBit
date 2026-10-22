import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, fileExtension, validateAudioFile } from '../src/audio/engine/fileValidation';

const f = (name: string, type: string, size = 1000) => ({ name, type, size });

describe('validateAudioFile', () => {
  it('accepts the supported formats by MIME type or extension', () => {
    for (const file of [
      f('a.mp3', 'audio/mpeg'),
      f('a.wav', 'audio/wav'),
      f('a.flac', ''),
      f('a.ogg', 'audio/ogg'),
      f('a.m4a', 'audio/x-m4a'),
      f('a.m4a', 'video/mp4'),
      f('track.AAC', ''),
      f('no-extension', 'audio/webm'),
    ]) {
      expect(validateAudioFile(file).ok).toBe(true);
    }
  });

  it('rejects files that are not audio', () => {
    const r = validateAudioFile(f('notes.txt', 'text/plain'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/NOT AN AUDIO FILE/);
    expect(validateAudioFile(f('photo.jpg', 'image/jpeg')).ok).toBe(false);
    expect(validateAudioFile(f('movie.mkv', 'video/x-matroska')).ok).toBe(false);
  });

  it('rejects empty and oversized files', () => {
    const empty = validateAudioFile(f('a.mp3', 'audio/mpeg', 0));
    expect(empty.ok).toBe(false);
    const big = validateAudioFile(f('a.wav', 'audio/wav', MAX_FILE_BYTES + 1));
    expect(big.ok).toBe(false);
  });

  it('derives a MIME type from the extension when the browser gives none', () => {
    const r = validateAudioFile(f('a.flac', ''));
    expect(r.ok && r.mime).toBe('audio/flac');
  });

  it('extracts lower-case extensions', () => {
    expect(fileExtension('Song.Final.MP3')).toBe('mp3');
    expect(fileExtension('README')).toBe('');
  });
});
