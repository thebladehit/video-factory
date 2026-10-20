import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assets } from '@vf/db';
import { assetKeys, LOCAL_USER_ID } from '@vf/shared';
import { cleanupStaleUploads } from '../src/modules/assets/cleanup';
import { mp3Bytes, mp4Bytes, pngBytes, upload, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

describe('asset.process', () => {
  it('processes an uploaded png into ready with metadata and thumbnail', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'фото.png', 'image/png', await pngBytes(640, 480));
    const a = await waitForAsset(deps, id, ['ready', 'failed']);
    expect(a).toMatchObject({ status: 'ready', width: 640, height: 480, mime: 'image/png', error: null });
    expect(a.thumbKey).toBe(assetKeys.thumb(LOCAL_USER_ID, id));
    expect(await deps.storage.head(a.thumbKey!)).toMatchObject({ contentType: 'image/webp' });
  });

  it('processes an mp4', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'clip.mp4', 'video/mp4', await mp4Bytes(2));
    const a = await waitForAsset(deps, id, ['ready', 'failed']);
    expect(a).toMatchObject({ status: 'ready', kind: 'video', width: 320, height: 180 });
    expect(Math.abs(a.durationMs! - 2000)).toBeLessThan(200);
    expect(a.thumbKey).not.toBeNull();
  });

  it('processes an mp3 without a thumbnail', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'song.mp3', 'audio/mpeg', await mp3Bytes());
    const a = await waitForAsset(deps, id, ['ready', 'failed']);
    expect(a).toMatchObject({ status: 'ready', kind: 'audio', thumbKey: null });
  });

  it('an mp4 that is actually text fails with an explanation', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'fake.mp4', 'video/mp4', new TextEncoder().encode('not a video at all'));
    const a = await waitForAsset(deps, id, ['ready', 'failed']);
    expect(a.status).toBe('failed');
    expect(a.error).toContain('Не вдалося прочитати файл');
  });

  it('a png uploaded as video/mp4 fails with kind mismatch', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'photo.mp4', 'video/mp4', await pngBytes());
    const a = await waitForAsset(deps, id, ['ready', 'failed']);
    expect(a.status).toBe('failed');
    expect(a.error).toContain('Тип файлу не збігається');
  });

  it('deleting the asset during processing ends quietly and leaves no thumbnail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vf-slow-'));
    const slow = join(dir, 'ffmpeg');
    await writeFile(slow, '#!/bin/sh\nsleep 1\nexec ffmpeg "$@"\n');
    await chmod(slow, 0o755);
    const { caller, deps } = await startApp({ ffmpegPath: slow });
    const id = await upload(caller, 'gone.png', 'image/png', await pngBytes());
    await new Promise((r) => setTimeout(r, 400));
    await deps.db.delete(assets).where(eq(assets.id, id));
    await new Promise((r) => setTimeout(r, 2000));
    expect(await deps.storage.head(assetKeys.thumb(LOCAL_USER_ID, id))).toBeNull();
    const failedJobs = await deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from jobs where type = 'asset.process' and status = 'failed' and payload->>'assetId' = ${id}`,
    );
    expect(failedJobs[0]!.n).toBe(0);
  });

  it('retryProcess re-runs a failed asset', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'bad.mp4', 'video/mp4', new TextEncoder().encode('broken'));
    await waitForAsset(deps, id, ['failed']);
    // «виправляємо» файл у сховищі й повторюємо
    const [row] = await deps.db.select().from(assets).where(eq(assets.id, id));
    await deps.storage.put(row!.storageKey, await mp4Bytes(1), { contentType: 'video/mp4' });
    await caller.assets.retryProcess({ id });
    expect((await waitForAsset(deps, id, ['ready', 'failed'])).status).toBe('ready');
  });
});

describe('cleanupStaleUploads', () => {
  it('removes uploading assets older than 24h and their multipart uploads', async () => {
    const { deps } = await startApp();
    const staleId = crypto.randomUUID();
    const freshId = crypto.randomUUID();
    const staleKey = assetKeys.original(LOCAL_USER_ID, staleId, 'mp4');
    const uploadId = await deps.storage.createMultipart(staleKey, { contentType: 'video/mp4' });
    const base = {
      userId: LOCAL_USER_ID,
      kind: 'video' as const,
      source: 'uploaded' as const,
      mime: 'video/mp4',
      status: 'uploading' as const,
    };
    await deps.db.insert(assets).values([
      { ...base, id: staleId, storageKey: staleKey, uploadId, createdAt: new Date(Date.now() - 25 * 3600_000) },
      { ...base, id: freshId, storageKey: assetKeys.original(LOCAL_USER_ID, freshId, 'mp4') },
    ]);
    expect(await cleanupStaleUploads(deps)).toBeGreaterThanOrEqual(1);
    expect(await deps.db.select().from(assets).where(eq(assets.id, staleId))).toHaveLength(0);
    expect(await deps.db.select().from(assets).where(eq(assets.id, freshId))).toHaveLength(1);
    await expect(deps.storage.listParts(staleKey, uploadId)).rejects.toThrow();
    await deps.db.delete(assets).where(eq(assets.id, freshId));
  });
});
