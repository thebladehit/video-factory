import { describe, expect, it } from 'vitest';
import { kindForMime, mimeFromName, MULTIPART_THRESHOLD, PART_SIZE, validateUpload } from './media-limits';

const MB = 1024 ** 2;

describe('validateUpload', () => {
  it('accepts a 50 MB png', () => {
    expect(validateUpload({ name: 'a.png', mime: 'image/png', size: 50 * MB })).toEqual({
      kind: 'image',
      mime: 'image/png',
      ext: 'png',
    });
  });

  it('rejects a png over 50 MB with the limit in the message', () => {
    expect(() => validateUpload({ name: 'a.png', mime: 'image/png', size: 50 * MB + 1 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', message: expect.stringContaining('50 МБ') }),
    );
  });

  it('rejects unsupported types', () => {
    expect(() => validateUpload({ name: 'a.pdf', mime: 'application/pdf', size: 10 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', message: expect.stringContaining('Непідтримуваний тип') }),
    );
  });

  it('falls back to the extension when the browser gives no mime', () => {
    expect(validateUpload({ name: 'clip.MOV', mime: '', size: 10 })).toEqual({
      kind: 'video',
      mime: 'video/quicktime',
      ext: 'mov',
    });
  });

  it('rejects a 6 GB video with the 5 GB limit', () => {
    expect(() => validateUpload({ name: 'v.mp4', mime: 'video/mp4', size: 6 * 1024 ** 3 })).toThrow(
      expect.objectContaining({ message: expect.stringContaining('5 ГБ') }),
    );
  });

  it('rejects empty files', () => {
    expect(() => validateUpload({ name: 'a.png', mime: 'image/png', size: 0 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });

  it('normalizes audio/x-wav and maps kinds', () => {
    expect(kindForMime('audio/x-wav')).toBe('audio');
    expect(kindForMime('image/heic')).toBeNull();
    expect(mimeFromName('song.m4a')).toBe('audio/mp4');
    expect(mimeFromName('noext')).toBeNull();
    expect(MULTIPART_THRESHOLD).toBe(64 * MB);
    expect(PART_SIZE).toBe(16 * MB);
  });
});
