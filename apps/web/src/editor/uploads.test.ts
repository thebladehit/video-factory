import { describe, expect, it } from 'vitest';
import { reconcileUploads, type TrackedUpload } from './uploads';

const item = (
  p: Partial<{
    id: string;
    name: string;
    progress: number;
    state: 'uploading' | 'processing' | 'done' | 'error';
    assetId: string;
    error: string;
  }>,
) => ({
  id: 'u1',
  name: 'a.mp4',
  progress: 0,
  bytesPerSec: 0,
  state: 'uploading' as const,
  ...p,
});
const tracked = (id: string, local = true): Map<string, TrackedUpload> => new Map([['u1', { id, local }]]);

describe('reconcileUploads', () => {
  it('asset id appeared → rewrite the local id', () => {
    expect(reconcileUploads([item({ assetId: 'A', progress: 10 })], tracked('local:u1'))).toEqual([
      { type: 'rewrite', uploadId: 'u1', from: 'local:u1', to: 'A' },
    ]);
  });

  it('progress of a still-local file', () => {
    expect(reconcileUploads([item({ assetId: 'A', progress: 40 })], tracked('A'))).toEqual([
      { type: 'progress', id: 'A', progress: 40 },
    ]);
  });

  it('error before the asset id → failed', () => {
    expect(reconcileUploads([item({ state: 'error', error: 'x' })], tracked('local:u1'))).toEqual([
      { type: 'failed', uploadId: 'u1', id: 'local:u1', message: 'Не вдалося завантажити «a.mp4»: x' },
    ]);
  });

  it('error after the asset id → failed too (does not keep blocking render)', () => {
    expect(reconcileUploads([item({ state: 'error', assetId: 'A', error: 'net' })], tracked('A'))).toEqual([
      { type: 'failed', uploadId: 'u1', id: 'A', message: 'Не вдалося завантажити «a.mp4»: net' },
    ]);
  });

  it('upload removed from the list (cancelled) → failed', () => {
    expect(reconcileUploads([], tracked('A'))).toEqual([
      { type: 'failed', uploadId: 'u1', id: 'A', message: 'Завантаження скасовано' },
    ]);
  });

  it('file no longer local → stop tracking', () => {
    expect(reconcileUploads([item({ assetId: 'A', state: 'processing' })], tracked('A', false))).toEqual([
      { type: 'forget', uploadId: 'u1' },
    ]);
  });

  it('error of an already processed file is not ours to undo', () => {
    expect(reconcileUploads([item({ assetId: 'A', state: 'error' })], tracked('A', false))).toEqual([
      { type: 'forget', uploadId: 'u1' },
    ]);
  });
});
