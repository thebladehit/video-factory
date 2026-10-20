import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAiRegistry, createEnvCredentialStore } from '@vf/ai';
import { assets, generations, userSettings } from '@vf/db';
import { AppError, assetKeys, LOCAL_USER_ID } from '@vf/shared';
import type { AppDeps } from '../src/index';
import { pngBytes, tools, upload, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

/** Згенерований файл, що чекає на обробку (так його створює image.generate) */
async function seedGenerated(deps: AppDeps, prompt: string) {
  const id = crypto.randomUUID();
  const storageKey = assetKeys.original(LOCAL_USER_ID, id, 'png');
  await deps.storage.put(storageKey, await pngBytes(), { contentType: 'image/png' });
  await deps.db.insert(assets).values({
    id,
    userId: LOCAL_USER_ID,
    kind: 'image',
    source: 'generated',
    status: 'processing',
    storageKey,
    mime: 'image/png',
    prompt,
    title: prompt,
  });
  await deps.jobs.queue.enqueue('asset.process', { assetId: id }, { userId: LOCAL_USER_ID });
  return id;
}

const taggingRows = (deps: AppDeps, assetId: string) =>
  deps.db
    .select()
    .from(generations)
    .then((rows) => rows.filter((g) => (g.params as { assetId?: string }).assetId === assetId));

const setSettings = (deps: AppDeps, patch: Partial<typeof userSettings.$inferInsert>) =>
  deps.db.update(userSettings).set(patch).where(eq(userSettings.userId, LOCAL_USER_ID));

describe('tagging', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  beforeEach(async () => {
    ctx = await startApp();
    await setSettings(ctx.deps, { defaults: {}, autoTagUploads: false });
  });

  it('a generated asset gets tags from its prompt', async () => {
    const id = await seedGenerated(ctx.deps, 'рудий кіт летить у відкритому космосі');
    const a = await waitForAsset(ctx.deps, id, ['ready', 'failed']);
    expect(a.status).toBe('ready');
    await expect
      .poll(async () => (await waitForAsset(ctx.deps, id, ['ready'])).tags)
      .toEqual(expect.arrayContaining(['рудий', 'кіт', 'космосі']));
    const [g] = await taggingRows(ctx.deps, id);
    expect(g).toMatchObject({ capability: 'text', provider: 'fake', model: 'text', status: 'done' });
  });

  it('an uploaded asset is not tagged when auto-tag is off', async () => {
    const id = await upload(ctx.caller, 'без-тегів.png', 'image/png', await pngBytes());
    const a = await waitForAsset(ctx.deps, id, ['ready']);
    await new Promise((r) => setTimeout(r, 300));
    expect(a.tags).toEqual([]);
    expect(await taggingRows(ctx.deps, id)).toHaveLength(0);
  });

  it('an uploaded asset is tagged by vision when auto-tag is on, keeping manual tags and the file name', async () => {
    await setSettings(ctx.deps, { autoTagUploads: true });
    const id = await upload(ctx.caller, 'відпустка.png', 'image/png', await pngBytes());
    await ctx.deps.db
      .update(assets)
      .set({ tags: ['моє'] })
      .where(eq(assets.id, id));
    await expect
      .poll(async () => (await waitForAsset(ctx.deps, id, ['ready'])).tags.length, { timeout: 10_000 })
      .toBeGreaterThan(1);
    const a = await waitForAsset(ctx.deps, id, ['ready']);
    expect(a.title).toBe('відпустка');
    expect(a.tags[0]).toBe('моє');
  });

  it('a tagging failure does not fail the asset', async () => {
    const real = createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }), media: tools });
    const broken = {
      ...real,
      text: async () => ({
        generateText: async () => '',
        generateObject: async () => {
          throw new AppError('PROVIDER_ERROR', 'fake: модель недоступна');
        },
      }),
    };
    const { deps } = await startApp({}, { ai: broken });
    const id = await seedGenerated(deps, 'зламаний тегер');
    expect((await waitForAsset(deps, id, ['ready', 'failed'])).status).toBe('ready');
    await expect.poll(async () => (await taggingRows(deps, id))[0]?.status).toBe('failed');
    expect((await taggingRows(deps, id))[0]!.error).toContain('модель недоступна');
  });

  it('without any tagger model tagging is skipped silently', async () => {
    const { deps } = await startApp({ aiFake: false });
    const id = await seedGenerated(deps, 'без моделі');
    expect((await waitForAsset(deps, id, ['ready', 'failed'])).status).toBe('ready');
    await new Promise((r) => setTimeout(r, 300));
    expect(await taggingRows(deps, id)).toHaveLength(0);
  });

  it('assets.tag tags an asset on demand', async () => {
    const id = await upload(ctx.caller, 'вручну.png', 'image/png', await pngBytes());
    await waitForAsset(ctx.deps, id, ['ready']);
    await ctx.caller.assets.tag({ id });
    await expect
      .poll(async () => (await waitForAsset(ctx.deps, id, ['ready'])).tags.length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(5);
    const rows = await taggingRows(ctx.deps, id);
    expect(rows.some((g) => (g.params as { mode?: string }).mode === 'image')).toBe(true);
  });
});
