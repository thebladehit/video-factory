import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assets, pipelineRuns, projects } from '@vf/db';
import { appRouter } from '../src/index';
import { addClip } from '@vf/timeline';
import { LOCAL_USER_ID, type PipelineSettings, type TimelineDoc } from '@vf/shared';
import { mp4Bytes, pngBytes, toneMp4Bytes, upload, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

type Started = Awaited<ReturnType<typeof startApp>>;

async function readyAsset(s: Started, kind: 'image' | 'video' = 'image') {
  const id =
    kind === 'image'
      ? await upload(s.caller, 'p.png', 'image/png', await pngBytes(64, 48))
      : await upload(s.caller, 'v.mp4', 'video/mp4', await mp4Bytes(1));
  await waitForAsset(s.deps, id, ['ready']);
  return id;
}

const withClip = (doc: TimelineDoc, assetId: string, kind: 'image' | 'video' = 'image', at = 0) =>
  addClip(doc, { id: assetId, kind, durationSec: kind === 'video' ? 1 : undefined, hasAudio: false }, { at }).doc;

describe('projects', () => {
  it('create → get returns an empty normalized 9:16 timeline at version 1', async () => {
    const { caller } = await startApp();
    const { id } = await caller.projects.create({ title: 'Перший', format: '9:16' });
    const p = await caller.projects.get({ id });
    expect(p).toMatchObject({ id, title: 'Перший', format: '9:16', version: 1, assets: {} });
    expect(p.timeline).toEqual({ schemaVersion: 1, width: 1080, height: 1920, fps: 30, tracks: [] });
  });

  it('save with baseVersion increments version and recomputes asset_ids', async () => {
    const s = await startApp();
    const a = await readyAsset(s);
    const { id } = await s.caller.projects.create({ title: 'P', format: '9:16' });
    const p = await s.caller.projects.get({ id });
    const doc = withClip(withClip(p.timeline, a), a, 'image', 10);
    expect(await s.caller.projects.save({ id, timeline: doc, baseVersion: 1 })).toEqual({ version: 2 });
    const [row] = await s.deps.db.select().from(projects).where(eq(projects.id, id));
    expect(row!.assetIds).toEqual([a]);
    expect(row!.timelineVersion).toBe(2);
    const again = await s.caller.projects.get({ id });
    expect(again.version).toBe(2);
    expect(again.assets[a]).toMatchObject({ id: a, missing: false, kind: 'image', status: 'ready', width: 64 });
  });

  it('save with stale baseVersion → CONFLICT and does not write', async () => {
    const s = await startApp();
    const a = await readyAsset(s);
    const { id } = await s.caller.projects.create({ title: 'P', format: '9:16' });
    const doc = (await s.caller.projects.get({ id })).timeline;
    await s.caller.projects.save({ id, timeline: doc, baseVersion: 1 });
    await expect(s.caller.projects.save({ id, timeline: withClip(doc, a), baseVersion: 1 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await s.caller.projects.get({ id })).timeline.tracks).toEqual([]);
  });

  it('save rejects an invalid timeline → VALIDATION', async () => {
    const { caller } = await startApp();
    const { id } = await caller.projects.create({ title: 'P', format: '9:16' });
    await expect(caller.projects.save({ id, timeline: { schemaVersion: 2 }, baseVersion: 1 })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'VALIDATION' }),
    });
  });

  it('save of 16:9 dimensions updates format', async () => {
    const { caller } = await startApp();
    const { id } = await caller.projects.create({ title: 'P', format: '9:16' });
    const doc = (await caller.projects.get({ id })).timeline;
    await caller.projects.save({ id, timeline: { ...doc, width: 1920, height: 1080 }, baseVersion: 1 });
    expect((await caller.projects.get({ id })).format).toBe('16:9');
  });

  it('get marks deleted assets as missing', async () => {
    const s = await startApp();
    const a = await readyAsset(s);
    const { id } = await s.caller.projects.create({ title: 'P', format: '9:16' });
    await s.caller.projects.save({
      id,
      timeline: withClip((await s.caller.projects.get({ id })).timeline, a),
      baseVersion: 1,
    });
    await s.caller.assets.delete({ id: a });
    const p = await s.caller.projects.get({ id });
    expect(p.assets[a]).toEqual({ id: a, missing: true });
    expect(p.timeline.tracks[0]!.clips).toHaveLength(1);
  });

  it('get enqueues asset.analyze for a used asset with has_audio null', async () => {
    const s = await startApp();
    const v = await upload(s.caller, 't.mp4', 'video/mp4', await toneMp4Bytes(1));
    await waitForAsset(s.deps, v, ['ready']);
    const { id } = await s.caller.projects.create({ title: 'P', format: '9:16' });
    await s.caller.projects.save({
      id,
      timeline: withClip((await s.caller.projects.get({ id })).timeline, v, 'video'),
      baseVersion: 1,
    });
    await s.deps.db.update(assets).set({ hasAudio: null, peaksKey: null }).where(eq(assets.id, v));
    await s.caller.projects.get({ id });
    const started = Date.now();
    for (;;) {
      const [r] = await s.deps.db.select().from(assets).where(eq(assets.id, v));
      if (r!.hasAudio !== null) {
        expect(r!.hasAudio).toBe(true);
        break;
      }
      if (Date.now() - started > 10_000) throw new Error('asset.analyze did not run');
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it('usage lists projects containing the asset', async () => {
    const s = await startApp();
    const a = await readyAsset(s);
    const one = await s.caller.projects.create({ title: 'Один', format: '9:16' });
    await s.caller.projects.create({ title: 'Без файлу', format: '9:16' });
    await s.caller.projects.save({
      id: one.id,
      timeline: withClip((await s.caller.projects.get({ id: one.id })).timeline, a),
      baseVersion: 1,
    });
    expect(await s.caller.assets.usage({ id: a })).toEqual([{ projectId: one.id, title: 'Один' }]);
  });

  it('list is ordered by updatedAt and shows thumb of the first visual clip', async () => {
    const s = await startApp();
    await s.deps.db.execute(sql`delete from projects`);
    const a = await readyAsset(s);
    const first = await s.caller.projects.create({ title: 'Старий', format: '9:16' });
    const second = await s.caller.projects.create({ title: 'Новий', format: '16:9' });
    await s.caller.projects.save({
      id: first.id,
      timeline: withClip((await s.caller.projects.get({ id: first.id })).timeline, a),
      baseVersion: 1,
    });
    const list = await s.caller.projects.list();
    expect(list.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(list[0]).toMatchObject({ title: 'Старий', format: '9:16', durationSec: 5 });
    expect(list[0]!.thumbUrl).toMatch(/thumb\.webp/);
    expect(list[1]).toMatchObject({ durationSec: 0, thumbUrl: null });
  });

  it('duplicate copies timeline with a new id and "(копія)" title', async () => {
    const s = await startApp();
    const a = await readyAsset(s);
    const { id } = await s.caller.projects.create({ title: 'Ролик', format: '9:16' });
    const doc = withClip((await s.caller.projects.get({ id })).timeline, a);
    await s.caller.projects.save({ id, timeline: doc, baseVersion: 1 });
    const copy = await s.caller.projects.duplicate({ id });
    expect(copy.id).not.toBe(id);
    const p = await s.caller.projects.get({ id: copy.id });
    expect(p).toMatchObject({ title: 'Ролик (копія)', version: 1 });
    expect(p.timeline).toEqual(doc);
    expect(await s.caller.assets.usage({ id: a })).toHaveLength(2);
  });

  it('rename and delete', async () => {
    const { caller } = await startApp();
    const { id } = await caller.projects.create({ title: 'A', format: '9:16' });
    await caller.projects.rename({ id, title: 'B' });
    expect((await caller.projects.get({ id })).title).toBe('B');
    await caller.projects.delete({ id });
    await expect(caller.projects.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("another user's project → NOT_FOUND", async () => {
    const s = await startApp();
    const { id } = await s.caller.projects.create({ title: 'Мій', format: '9:16' });
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(stranger.projects.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      stranger.projects.save({ id, timeline: (await s.caller.projects.get({ id })).timeline, baseVersion: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(stranger.projects.rename({ id, title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(stranger.projects.delete({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await stranger.projects.list()).toEqual([]);
  });

  it('assets({ids}) ignores foreign ids (→ missing)', async () => {
    const s = await startApp();
    const a = await readyAsset(s);
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    expect(await stranger.projects.assets({ ids: [a, 'local:1'] })).toEqual({
      [a]: { id: a, missing: true },
      'local:1': { id: 'local:1', missing: true },
    });
    const mine = await s.caller.projects.assets({ ids: [a] });
    expect(mine[a]).toMatchObject({
      missing: false,
      url: expect.stringContaining('original'),
      peaksUrl: null,
      hasAudio: false,
    });
    expect(Date.parse((mine[a] as { urlExpiresAt: string }).urlExpiresAt)).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('language versions: get/save with language work on the separated copy with its own version', async () => {
    const s = await startApp();
    const a = await readyAsset(s);
    const { id } = await s.caller.projects.create({ title: 'P', format: '9:16' });
    const doc = withClip((await s.caller.projects.get({ id })).timeline, a);
    await s.caller.projects.save({ id, timeline: doc, baseVersion: 1 });
    await expect(s.caller.projects.get({ id, language: 'uk' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.caller.projects.save({ id, language: 'uk', timeline: doc, baseVersion: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    await s.caller.voice.separate({ projectId: id, language: 'uk' });
    const sep = await s.caller.projects.get({ id, language: 'uk' });
    expect(sep).toMatchObject({ id, version: 1, timeline: doc });
    expect(sep.assets[a]).toMatchObject({ missing: false });
    const shorter = withClip(doc, a, 'image', 10);
    expect(await s.caller.projects.save({ id, language: 'uk', timeline: shorter, baseVersion: 1 })).toEqual({
      version: 2,
    });
    await expect(s.caller.projects.save({ id, language: 'uk', timeline: doc, baseVersion: 1 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await s.caller.projects.get({ id, language: 'uk' })).timeline).toEqual(shorter);
    expect(await s.caller.projects.get({ id })).toMatchObject({ version: 2, timeline: doc });
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(stranger.projects.get({ id, language: 'uk' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(stranger.projects.save({ id, language: 'uk', timeline: doc, baseVersion: 2 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('projects.get returns pipeline stage and status for a pipeline project and null otherwise', async () => {
    const s = await startApp();
    const plain = await s.caller.projects.create({ title: 'Без запуску', format: '9:16' });
    expect((await s.caller.projects.get({ id: plain.id })).pipeline).toBeNull();
    const { id } = await s.caller.projects.create({ title: 'Конвеєр', format: '9:16' });
    await s.deps.db.insert(pipelineRuns).values({
      userId: LOCAL_USER_ID,
      projectId: id,
      settings: {} as PipelineSettings,
      stage: 'review',
      status: 'awaiting_review',
    });
    expect((await s.caller.projects.get({ id })).pipeline).toEqual({ stage: 'review', status: 'awaiting_review' });
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(stranger.projects.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
