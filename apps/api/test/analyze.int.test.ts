import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assets } from '@vf/db';
import { assetKeys, LOCAL_USER_ID } from '@vf/shared';
import type { AppDeps } from '../src/index';
import { mp3Bytes, mp4Bytes, pngBytes, toneMp4Bytes, upload, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const row = async (deps: AppDeps, id: string) => (await deps.db.select().from(assets).where(eq(assets.id, id)))[0]!;

describe('audio analysis', () => {
  it('asset.process stores has_audio and peaks for video with sound', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'tone.mp4', 'video/mp4', await toneMp4Bytes(2));
    const a = await waitForAsset(deps, id, ['ready', 'failed']);
    expect(a).toMatchObject({ status: 'ready', hasAudio: true, peaksKey: assetKeys.peaks(LOCAL_USER_ID, id) });
    const obj = await deps.storage.get(a.peaksKey!);
    const bytes = Buffer.concat(await obj.body.toArray());
    expect(Math.abs(bytes.length - 200)).toBeLessThanOrEqual(3);
  });

  it('silent video gets has_audio false and no peaks', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'mute.mp4', 'video/mp4', await mp4Bytes(1));
    expect(await waitForAsset(deps, id, ['ready', 'failed'])).toMatchObject({ hasAudio: false, peaksKey: null });
  });

  it('audio gets peaks', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'song.mp3', 'audio/mpeg', await mp3Bytes());
    expect(await waitForAsset(deps, id, ['ready', 'failed'])).toMatchObject({
      hasAudio: true,
      peaksKey: assetKeys.peaks(LOCAL_USER_ID, id),
    });
  });

  it('image gets has_audio false and no peaks', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'p.png', 'image/png', await pngBytes());
    expect(await waitForAsset(deps, id, ['ready', 'failed'])).toMatchObject({ hasAudio: false, peaksKey: null });
  });

  it('startup enqueues asset.analyze for ready video with has_audio null and fills it', async () => {
    const first = await startApp();
    const id = await upload(first.caller, 'old.mp4', 'video/mp4', await toneMp4Bytes(1));
    await waitForAsset(first.deps, id, ['ready']);
    await first.deps.db.update(assets).set({ hasAudio: null, peaksKey: null }).where(eq(assets.id, id));
    await first.close();

    const { deps } = await startApp();
    const a = await waitFor(async () => {
      const r = await row(deps, id);
      return r.hasAudio !== null ? r : null;
    });
    expect(a).toMatchObject({ hasAudio: true, peaksKey: assetKeys.peaks(LOCAL_USER_ID, id) });
    const jobs = await deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from jobs where type = 'asset.analyze' and payload->>'assetId' = ${id}`,
    );
    expect(jobs[0]!.n).toBe(1);
  });

  it('asset.analyze is idempotent', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'again.mp4', 'video/mp4', await toneMp4Bytes(1));
    await waitForAsset(deps, id, ['ready']);
    await deps.db.update(assets).set({ hasAudio: null, peaksKey: null }).where(eq(assets.id, id));
    await deps.jobs.queue.enqueue('asset.analyze', { assetId: id }, { userId: LOCAL_USER_ID });
    const first = await waitFor(async () => {
      const r = await row(deps, id);
      return r.peaksKey ? r : null;
    });
    // підміняємо піки — повтор задачі не має їх перезаписати
    await deps.storage.put(first.peaksKey!, new Uint8Array([7]), { contentType: 'application/octet-stream' });
    const jobId = await deps.jobs.queue.enqueue('asset.analyze', { assetId: id }, { userId: LOCAL_USER_ID });
    await waitFor(async () => {
      const [j] = await deps.db.execute<{ status: string }>(sql`select status from jobs where id = ${jobId}`);
      return j?.status === 'done' ? j : null;
    });
    const again = await row(deps, id);
    expect(again.peaksKey).toBe(first.peaksKey);
    const obj = await deps.storage.get(again.peaksKey!);
    expect([...Buffer.concat(await obj.body.toArray())]).toEqual([7]);
  });
});

describe('audio analysis failures', () => {
  it('a broken audio track does not fail the file: ready with has_audio false', async () => {
    const { chmod, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'vf-nopeaks-'));
    const bin = join(dir, 'ffmpeg');
    // ffmpeg, що падає саме на витягуванні піків (f32le), як на пошкодженому аудіопотоці
    await writeFile(bin, '#!/bin/sh\ncase "$*" in *f32le*) echo "broken audio" >&2; exit 1;; esac\nexec ffmpeg "$@"\n');
    await chmod(bin, 0o755);
    const { caller, deps } = await startApp({ ffmpegPath: bin });
    const id = await upload(caller, 'broken.mp4', 'video/mp4', await toneMp4Bytes(1));
    const a = await waitForAsset(deps, id, ['ready', 'failed']);
    expect(a).toMatchObject({ status: 'ready', hasAudio: false, peaksKey: null, error: null });
  });
});
