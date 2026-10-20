import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAiRegistry, createEnvCredentialStore, type AiRegistry, type VideoGen } from '@vf/ai';
import { assets, generations, jobs } from '@vf/db';
import type { JobEvent } from '@vf/shared';
import { LOCAL_USER_ID } from '@vf/shared';
import type { AppDeps } from '../src/index';
import { imageGenerateJob } from '../src/modules/generate/image-job';
import { mp4Bytes, tools, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

const fast = { videoPollMs: 50, videoTimeoutMs: 60_000 };
const fakeAi = () => createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }), media: tools });
const withVideo = (video: VideoGen): AiRegistry => ({ ...fakeAi(), video: async () => video });

async function waitForGeneration(deps: AppDeps, id: string, statuses: string[], timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const [g] = await deps.db.select().from(generations).where(eq(generations.id, id));
    if (g && statuses.includes(g.status)) return g;
    if (Date.now() - started > timeoutMs) throw new Error(`generation ${id} stuck in ${g?.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('generate', () => {
  it('image generation creates n generated assets that become ready with tags', async () => {
    const { caller, deps } = await startApp(fast);
    const prompt = 'помаранчевий кіт на даху вночі';
    const { generationId } = await caller.generate.image({ model: 'fake/image', prompt, aspect: '9:16', n: 2 });
    const g = await waitForGeneration(deps, generationId, ['done', 'failed']);
    expect(g).toMatchObject({ status: 'done', capability: 'image', provider: 'fake', model: 'image' });
    expect(g.assetIds).toHaveLength(2);
    expect(Number(g.costEstimate)).toBe(0);
    for (const id of g.assetIds) {
      const a = await waitForAsset(deps, id, ['ready', 'failed']);
      expect(a).toMatchObject({ status: 'ready', source: 'generated', prompt, generationId, width: 540, height: 960 });
      expect(a.title).toBe(prompt);
    }
    await expect
      .poll(async () => (await waitForAsset(deps, g.assetIds[0]!, ['ready'])).tags)
      .toEqual(expect.arrayContaining(['помаранчевий', 'кіт']));
  });

  it('rejects unsupported n or aspect, and unavailable models, before enqueuing', async () => {
    const { caller, deps } = await startApp(fast);
    const before = (await deps.db.select().from(generations)).length;
    await expect(
      caller.generate.image({ model: 'fake/image', prompt: 'x', aspect: '1:1', n: 5 }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller.generate.video({ model: 'fake/video', prompt: 'x', aspect: '9:16', durationSec: 7 }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller.generate.image({ model: 'openai/gpt-image-2', prompt: 'x', aspect: '1:1', n: 1 }),
    ).rejects.toMatchObject({
      cause: { code: 'MODEL_UNAVAILABLE' },
    });
    expect((await deps.db.select().from(generations)).length).toBe(before);
  });

  it('retrying a finished image job does not duplicate assets', async () => {
    const { caller, deps } = await startApp(fast);
    const { generationId } = await caller.generate.image({
      model: 'fake/image',
      prompt: 'повтор',
      aspect: '1:1',
      n: 2,
    });
    await waitForGeneration(deps, generationId, ['done']);
    const ctx = {
      jobId: crypto.randomUUID(),
      userId: LOCAL_USER_ID,
      progress: async () => {},
      signal: new AbortController().signal,
    };
    await imageGenerateJob(deps).handler({ generationId }, ctx);
    const rows = await deps.db.select().from(assets).where(eq(assets.generationId, generationId));
    expect(rows).toHaveLength(2);
  });

  it('video generation polls until done, stores provider_op first and reports monotonic progress', async () => {
    const { caller, deps } = await startApp(fast);
    const events: JobEvent[] = [];
    deps.jobs.queue.onEvent((e) => events.push(e));
    const { generationId, jobId } = await caller.generate.video({
      model: 'fake/video',
      prompt: 'хвилі',
      aspect: '16:9',
      durationSec: 2,
    });
    const g = await waitForGeneration(deps, generationId, ['done', 'failed']);
    expect(g.status).toBe('done');
    expect(g.providerOp).not.toBeNull();
    const a = await waitForAsset(deps, g.assetIds[0]!, ['ready', 'failed']);
    expect(a).toMatchObject({ status: 'ready', kind: 'video', width: 960, height: 540 });
    expect(Math.abs(a.durationMs! - 2000)).toBeLessThan(200);
    const progress = events.filter((e) => e.jobId === jobId).map((e) => e.progress);
    expect(progress).toEqual([...progress].sort((x, y) => x - y));
  });

  it('video job resumes from provider_op without calling start', async () => {
    let starts = 0;
    const bytes = await mp4Bytes(1);
    const video: VideoGen = {
      start: async () => {
        starts++;
        return { provider: 'fake', data: { id: 'new' } };
      },
      poll: async () => [{ bytes, mime: 'video/mp4' }],
    };
    const { deps } = await startApp(fast, { ai: withVideo(video) });
    const [g] = await deps.db
      .insert(generations)
      .values({
        userId: LOCAL_USER_ID,
        capability: 'video',
        provider: 'fake',
        model: 'video',
        prompt: 'відновлення',
        params: { aspect: '16:9', durationSec: 2 },
        providerOp: { provider: 'fake', data: { id: 'old' } },
      })
      .returning();
    await deps.jobs.queue.enqueue('video.generate', { generationId: g!.id }, { userId: LOCAL_USER_ID });
    const done = await waitForGeneration(deps, g!.id, ['done', 'failed']);
    expect(done.status).toBe('done');
    expect(starts).toBe(0);
  });

  it('a provider failure marks the generation failed with the provider text', async () => {
    const video: VideoGen = {
      start: async () => ({ provider: 'fake', data: { id: 'x' } }),
      poll: async () => ({ state: 'failed', error: 'content policy violation' }),
    };
    const { caller, deps } = await startApp(fast, { ai: withVideo(video) });
    const { generationId, jobId } = await caller.generate.video({
      model: 'fake/video',
      prompt: 'x',
      aspect: '9:16',
      durationSec: 2,
    });
    const g = await waitForGeneration(deps, generationId, ['failed', 'done']);
    expect(g.status).toBe('failed');
    expect(g.error).toContain('content policy');
    await expect
      .poll(async () => (await deps.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]?.status)
      .toBe('failed');
  });

  it('video times out', async () => {
    const video: VideoGen = {
      start: async () => ({ provider: 'fake', data: { id: 'x' } }),
      poll: async () => ({ state: 'running' }),
    };
    const { caller, deps } = await startApp({ videoPollMs: 50, videoTimeoutMs: 400 }, { ai: withVideo(video) });
    const { generationId } = await caller.generate.video({
      model: 'fake/video',
      prompt: 'x',
      aspect: '9:16',
      durationSec: 2,
    });
    const g = await waitForGeneration(deps, generationId, ['failed', 'done']);
    expect(g.error).toContain('Перевищено час очікування');
  });

  it('estimate returns catalog price × n or × seconds', async () => {
    const { caller } = await startApp(fast);
    expect(await caller.generate.estimate({ capability: 'image', model: 'fake/image', n: 3 })).toEqual({ usd: 0 });
    expect(await caller.generate.estimate({ capability: 'video', model: 'fake/video', durationSec: 2 })).toEqual({
      usd: 0,
    });
  });

  it('list shows active and failed generations', async () => {
    const video: VideoGen = {
      start: async () => ({ provider: 'fake', data: { id: 'x' } }),
      poll: async () => ({ state: 'failed', error: 'нема' }),
    };
    const { caller, deps } = await startApp(fast, { ai: withVideo(video) });
    const { generationId } = await caller.generate.video({
      model: 'fake/video',
      prompt: 'у списку',
      aspect: '9:16',
      durationSec: 2,
    });
    await waitForGeneration(deps, generationId, ['failed']);
    const list = await caller.generate.list();
    expect(list.find((g) => g.id === generationId)).toMatchObject({
      status: 'failed',
      prompt: 'у списку',
      model: 'fake/video',
    });
  });
});
