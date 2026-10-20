import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAiRegistry, createEnvCredentialStore, type AiRegistry, type ImageGen, type VideoGen } from '@vf/ai';
import { assets, createDb, generations } from '@vf/db';
import { assetKeys, LOCAL_USER_ID } from '@vf/shared';
import type { AppDeps } from '../src/index';
import { mp4Bytes, pngBytes, tools, upload, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

const fast = { videoPollMs: 50, videoTimeoutMs: 60_000 };
const fakeAi = () => createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }), media: tools });

async function waitForGeneration(deps: AppDeps, id: string, statuses: string[], timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const [g] = await deps.db.select().from(generations).where(eq(generations.id, id));
    if (g && statuses.includes(g.status)) return g;
    if (Date.now() - started > timeoutMs) throw new Error(`generation ${id} stuck in ${g?.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('recovery after restart', () => {
  it('a video interrupted by shutdown is not cancelled and resumes from provider_op after restart', async () => {
    let starts = 0;
    let ready = false;
    const bytes = await mp4Bytes(1);
    const video: VideoGen = {
      start: async () => {
        starts++;
        return { provider: 'fake', data: { id: 'op-1' } };
      },
      poll: async () => (ready ? [{ bytes, mime: 'video/mp4' }] : { state: 'running' }),
    };
    const ai: AiRegistry = { ...fakeAi(), video: async () => video };
    const first = await startApp(fast, { ai });
    const { generationId } = await first.caller.generate.video({
      model: 'fake/video',
      prompt: 'рестарт',
      aspect: '9:16',
      durationSec: 2,
    });
    await expect
      .poll(async () => (await waitForGeneration(first.deps, generationId, ['running'])).providerOp)
      .not.toBeNull();
    await first.close();
    const probe = createDb(process.env.TEST_DATABASE_URL!);
    const [after] = await probe.db.select().from(generations).where(eq(generations.id, generationId));
    await probe.close();
    expect(after!.status).not.toBe('cancelled');

    ready = true;
    const second = await startApp(fast, { ai });
    const g = await waitForGeneration(second.deps, generationId, ['done', 'failed']);
    expect(g.status).toBe('done');
    expect(starts).toBe(1);
  }, 30_000);

  it('an asset left in processing without a job is processed after restart', async () => {
    const { deps } = await startApp(fast);
    const id = crypto.randomUUID();
    const storageKey = assetKeys.original(LOCAL_USER_ID, id, 'png');
    await deps.storage.put(storageKey, await pngBytes(), { contentType: 'image/png' });
    await deps.db.insert(assets).values({
      id,
      userId: LOCAL_USER_ID,
      kind: 'image',
      source: 'uploaded',
      status: 'processing',
      storageKey,
      mime: 'image/png',
    });
    const restarted = await startApp(fast);
    expect((await waitForAsset(restarted.deps, id, ['ready', 'failed'])).status).toBe('ready');
  }, 20_000);

  it('retryProcess accepts a processing asset with no live job', async () => {
    const { caller, deps } = await startApp(fast);
    const id = crypto.randomUUID();
    const storageKey = assetKeys.original(LOCAL_USER_ID, id, 'png');
    await deps.storage.put(storageKey, await pngBytes(), { contentType: 'image/png' });
    await deps.db.insert(assets).values({
      id,
      userId: LOCAL_USER_ID,
      kind: 'image',
      source: 'uploaded',
      status: 'processing',
      storageKey,
      mime: 'image/png',
    });
    await caller.assets.retryProcess({ id });
    expect((await waitForAsset(deps, id, ['ready', 'failed'])).status).toBe('ready');
  });

  it('a generation cancelled while queued disappears from the list', async () => {
    const video: VideoGen = {
      start: async () => ({ provider: 'fake', data: { id: 'x' } }),
      poll: async () => ({ state: 'running' }),
    };
    const { caller } = await startApp(
      { videoPollMs: 50, videoTimeoutMs: 5000 },
      { ai: { ...fakeAi(), video: async () => video } },
    );
    const started = [];
    for (let i = 0; i < 3; i++) {
      started.push(
        await caller.generate.video({ model: 'fake/video', prompt: `черга ${i}`, aspect: '9:16', durationSec: 2 }),
      );
    }
    const last = started[2]!;
    await caller.jobs.cancel({ id: last.jobId });
    await expect.poll(async () => (await caller.generate.list()).some((g) => g.id === last.generationId)).toBe(false);
    for (const s of started.slice(0, 2)) await caller.jobs.cancel({ id: s.jobId });
  });

  it('an ffmpeg failure with an absolute tool path fails the asset instead of leaving it processing', async () => {
    const { caller, deps } = await startApp({ ffmpegPath: '/usr/bin/false' });
    const id = await upload(caller, 'abs.png', 'image/png', await pngBytes());
    const a = await waitForAsset(deps, id, ['ready', 'failed']);
    expect(a.status).toBe('failed');
    expect(a.error).toContain('мініатюр');
  }, 20_000);

  it('a storage failure while saving generated files does not pay twice on retry', async () => {
    let generateCalls = 0;
    const png = await pngBytes();
    const image: ImageGen = {
      generate: async () => {
        generateCalls++;
        return [
          { bytes: png, mime: 'image/png' },
          { bytes: png, mime: 'image/png' },
        ];
      },
    };
    const { deps: base } = await startApp(fast);
    let puts = 0;
    const flaky = {
      ...base.storage,
      put: async (...args: Parameters<typeof base.storage.put>) => {
        if (args[0].endsWith('/original.png') && ++puts === 2) throw new Error('S3 timeout');
        return base.storage.put(...args);
      },
    };
    const { caller, deps } = await startApp(fast, { ai: { ...fakeAi(), image: async () => image }, storage: flaky });
    const { generationId, jobId } = await caller.generate.image({
      model: 'fake/image',
      prompt: 'збій',
      aspect: '1:1',
      n: 2,
    });
    expect((await waitForGeneration(deps, generationId, ['failed', 'done'])).status).toBe('failed');
    await caller.jobs.retry({ id: jobId });
    await expect
      .poll(async () => (await waitForGeneration(deps, generationId, ['failed', 'done'])).assetIds.length)
      .toBe(2);
    const g = (await deps.db.select().from(generations).where(eq(generations.id, generationId)))[0]!;
    const statuses = await Promise.all(
      g.assetIds.map(async (id) => (await waitForAsset(deps, id, ['ready', 'failed'])).status),
    );
    expect(statuses.sort()).toEqual(['failed', 'ready']);
    expect(generateCalls).toBe(1);
  }, 30_000);
});
