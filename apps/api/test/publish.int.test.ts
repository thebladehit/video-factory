import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assets, generations, projects, publications, userSettings, voiceLines } from '@vf/db';
import { validateMeta } from '@vf/publish';
import { makeRender, start, type Started } from './publish-helpers';

const meta = (title = 'Назва') => ({ title, description: 'Опис', tags: [] as string[] });
const tiktokMeta = { title: '', description: 'Підпис', tags: [] as string[] };

async function manualAccount(s: Started, platform: 'tiktok' | 'instagram' | 'facebook' = 'tiktok') {
  return s.caller.publish.accounts.createManual({ platform, name: 'Акаунт', language: 'uk' });
}

/** Акаунт YouTube (api) напряму в БД — OAuth тут не потрібен */
async function youtubeAccount(s: Started) {
  const { socialAccounts } = await import('@vf/db');
  const [a] = await s.deps.db
    .insert(socialAccounts)
    .values({
      userId: s.userId,
      platform: 'youtube',
      method: 'api',
      name: 'Канал',
      language: 'uk',
      externalId: `c-${crypto.randomUUID()}`,
    })
    .returning();
  return a!;
}

const pubRow = async (s: Started, id: string) =>
  (await s.deps.db.select().from(publications).where(eq(publications.id, id)))[0]!;

describe('publish.versions', () => {
  it('returns latest done final render per language, ignores draft and failed', async () => {
    const s = await start();
    const old = await makeRender(s, { title: 'П' });
    const latest = await makeRender(s, { projectId: old.projectId });
    await makeRender(s, { projectId: old.projectId, preset: 'draft' });
    await makeRender(s, { projectId: old.projectId, status: 'failed' });
    await makeRender(s, { projectId: old.projectId, withAsset: false });
    const en = await makeRender(s, { projectId: old.projectId, language: 'en' });
    const versions = await s.caller.publish.versions({ projectId: old.projectId });
    expect(versions.map((v) => [v.language, v.renderId]).sort()).toEqual(
      [
        ['uk', latest.renderId],
        ['en', en.renderId],
      ].sort(),
    );
    expect(versions[0]).toMatchObject({
      projectId: old.projectId,
      projectTitle: 'П',
      format: '9:16',
      durationMs: 12_000,
    });
    expect(await s.caller.publish.versions()).toHaveLength(2);
  });

  it('returns presigned thumbUrl for the render file (null without thumb)', async () => {
    const s = await start();
    const uk = await makeRender(s);
    const en = await makeRender(s, { projectId: uk.projectId, language: 'en' });
    await s.deps.db.update(assets).set({ thumbKey: 'test/thumb-en.jpg' }).where(eq(assets.id, en.assetId!));
    const versions = await s.caller.publish.versions({ projectId: uk.projectId });
    const byLang = Object.fromEntries(versions.map((v) => [v.language, v]));
    expect(byLang.en!.thumbUrl).toContain('thumb-en.jpg');
    expect(byLang.uk!.thumbUrl).toBeNull();
  });
});

describe('publish.create', () => {
  it('manual tiktok now → awaiting_manual; pendingCount 1', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId, projectId } = await makeRender(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta: tiktokMeta }] });
    expect(await pubRow(s, id!)).toMatchObject({
      status: 'awaiting_manual',
      method: 'manual',
      platform: 'tiktok',
      language: 'uk',
      projectId,
    });
    expect(await s.caller.publish.pendingCount()).toBe(1);
    const list = await s.caller.publish.list({ projectId });
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('uploadSession');
    expect(await s.caller.publish.list({ status: 'failed' })).toHaveLength(0);
  });

  it('manual with future time → scheduled', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId } = await makeRender(s);
    const at = new Date(Date.now() + 3600_000).toISOString();
    const [id] = await s.caller.publish.create({
      items: [{ renderId, accountId: acc.id, meta: tiktokMeta, scheduledAt: at }],
    });
    expect(await pubRow(s, id!)).toMatchObject({ status: 'scheduled' });
    expect(await s.caller.publish.pendingCount()).toBe(0);
  });

  it('twice same render+account → CONFLICT; after cancel → ok', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId } = await makeRender(s);
    const items = [{ renderId, accountId: acc.id, meta: tiktokMeta }];
    const [id] = await s.caller.publish.create({ items });
    await expect(s.caller.publish.create({ items })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Ця версія вже публікується на цей акаунт',
    });
    await s.caller.publish.cancel({ id: id! });
    await s.caller.publish.create({ items });
  });

  it('batch is atomic: duplicate inside batch rolls everything back', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId } = await makeRender(s);
    const item = { renderId, accountId: acc.id, meta: tiktokMeta };
    await expect(s.caller.publish.create({ items: [item, item] })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await s.caller.publish.list()).toHaveLength(0);
  });

  it('youtube with title 101 chars → VALIDATION with details.errors', async () => {
    const s = await start();
    const acc = await youtubeAccount(s);
    const { renderId } = await makeRender(s);
    const err = await s.caller.publish
      .create({ items: [{ renderId, accountId: acc.id, meta: meta('я'.repeat(101)) }] })
      .catch((e) => e);
    expect(err.cause.code).toBe('VALIDATION');
    expect(err.cause.details.errors.length).toBeGreaterThan(0);
    expect(err.message).toBe(err.cause.details.errors[0]);
  });

  it('youtube scheduled in 2 min → VALIDATION; in 10 min → created with publish job', async () => {
    const s = await start();
    const acc = await youtubeAccount(s);
    const { renderId } = await makeRender(s);
    const soon = new Date(Date.now() + 2 * 60_000).toISOString();
    await expect(
      s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta: meta(), scheduledAt: soon }] }),
    ).rejects.toMatchObject({
      cause: { code: 'VALIDATION', message: 'Час публікації на YouTube має бути щонайменше через 5 хвилин' },
    });
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    const [id] = await s.caller.publish.create({
      items: [{ renderId, accountId: acc.id, meta: meta(), scheduledAt: later }],
    });
    // задача ставиться одразу: статус далі веде вона (див. publish-job.int)
    const row = await pubRow(s, id!);
    expect(row).toMatchObject({ method: 'api' });
    expect(row.jobId).not.toBeNull();
  });

  it('rejects draft render, foreign render and inactive account', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const draft = await makeRender(s, { preset: 'draft' });
    await expect(
      s.caller.publish.create({ items: [{ renderId: draft.renderId, accountId: acc.id, meta: tiktokMeta }] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const ok = await makeRender(s);
    const { socialAccounts } = await import('@vf/db');
    await s.deps.db.update(socialAccounts).set({ status: 'reauth_required' }).where(eq(socialAccounts.id, acc.id));
    await expect(
      s.caller.publish.create({ items: [{ renderId: ok.renderId, accountId: acc.id, meta: tiktokMeta }] }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
  });
});

describe('publish manual path', () => {
  it('markPublished with tiktok url → published, platform_post_id, project published', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId, projectId } = await makeRender(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta: tiktokMeta }] });
    await expect(
      s.caller.publish.markPublished({ id: id!, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
    ).rejects.toMatchObject({
      cause: { code: 'VALIDATION', message: 'Це не посилання на TikTok' },
    });
    await s.caller.publish.markPublished({
      id: id!,
      url: 'https://www.tiktok.com/@me/video/7234567890123456789?lang=uk',
    });
    const row = await pubRow(s, id!);
    expect(row).toMatchObject({ status: 'published', platformPostId: '7234567890123456789' });
    expect(row.publishedAt).not.toBeNull();
    const [p] = await s.deps.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p!.status).toBe('published');
    await expect(
      s.caller.publish.markPublished({ id: id!, url: 'https://www.tiktok.com/@me/video/7234567890123456789' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('downloadUrl contains attachment filename', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId } = await makeRender(s, { title: 'Мій ролик' });
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta: tiktokMeta }] });
    const { url } = await s.caller.publish.downloadUrl({ id: id! });
    const decoded = decodeURIComponent(decodeURIComponent(url));
    expect(decoded).toContain('attachment');
    expect(decoded).toContain('Мій ролик-uk.mp4');
  });

  it('updateMeta: validates, reschedules manual into the future, rejects final states', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId } = await makeRender(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta: tiktokMeta }] });
    await expect(
      s.caller.publish.updateMeta({ id: id!, meta: { ...tiktokMeta, description: 'x'.repeat(2201) } }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    const at = new Date(Date.now() + 3600_000).toISOString();
    await s.caller.publish.updateMeta({ id: id!, meta: { ...tiktokMeta, description: 'Новий' }, scheduledAt: at });
    expect(await pubRow(s, id!)).toMatchObject({ status: 'scheduled', metadata: { description: 'Новий' } });
    await s.caller.publish.cancel({ id: id! });
    await expect(s.caller.publish.updateMeta({ id: id!, meta: tiktokMeta })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('cancel scheduled → cancelled; retry failed → scheduled', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const a = await makeRender(s);
    const b = await makeRender(s);
    const future = new Date(Date.now() + 3600_000).toISOString();
    const [id1] = await s.caller.publish.create({
      items: [{ renderId: a.renderId, accountId: acc.id, meta: tiktokMeta, scheduledAt: future }],
    });
    await s.caller.publish.cancel({ id: id1! });
    expect((await pubRow(s, id1!)).status).toBe('cancelled');
    await expect(s.caller.publish.cancel({ id: id1! })).rejects.toMatchObject({ code: 'CONFLICT' });

    const [id2] = await s.caller.publish.create({
      items: [{ renderId: b.renderId, accountId: acc.id, meta: tiktokMeta, scheduledAt: future }],
    });
    await expect(s.caller.publish.retry({ id: id2! })).rejects.toMatchObject({ code: 'CONFLICT' });
    await s.deps.db.update(publications).set({ status: 'failed', error: 'boom' }).where(eq(publications.id, id2!));
    await s.caller.publish.retry({ id: id2! });
    const row = await pubRow(s, id2!);
    expect(row).toMatchObject({ status: 'scheduled', error: null });
    expect(row.scheduledAt?.toISOString()).toBe(future);
  });

  it("another user's publication → NOT_FOUND", async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId } = await makeRender(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta: tiktokMeta }] });
    const other = await start();
    await expect(other.caller.publish.cancel({ id: id! })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('delete guards', () => {
  it('deleteProject with awaiting_manual publication → CONFLICT; after markPublished → delete ok, publications gone', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId, projectId } = await makeRender(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta: tiktokMeta }] });
    await expect(s.caller.projects.delete({ id: projectId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Є публікації в роботі — скасуйте їх або дочекайтесь завершення',
    });
    await s.caller.publish.markPublished({ id: id!, url: 'https://www.tiktok.com/@me/video/7234567890123456789' });
    await s.caller.projects.delete({ id: projectId });
    expect(await s.deps.db.select().from(publications).where(eq(publications.id, id!))).toHaveLength(0);
  });

  it('deleteAsset of render output with live publication → CONFLICT', async () => {
    const s = await start();
    const acc = await manualAccount(s);
    const { renderId, assetId } = await makeRender(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta: tiktokMeta }] });
    await expect(s.caller.assets.delete({ id: assetId! })).rejects.toMatchObject({ code: 'CONFLICT' });
    await s.caller.publish.cancel({ id: id! });
    await s.caller.assets.delete({ id: assetId! });
  });
});

describe('publish.generateMeta', () => {
  const genCount = async (s: Started, projectId: string) =>
    (await s.deps.db.select().from(generations).where(eq(generations.userId, s.userId))).filter(
      (g) =>
        (g.params as { purpose?: string; projectId?: string }).purpose === 'publish-meta' &&
        (g.params as { projectId?: string }).projectId === projectId,
    );

  async function ready() {
    const s = await start();
    await s.caller.settings.setDefault({ capability: 'text', ref: 'fake/text' });
    const r = await makeRender(s, { title: 'Космічна подорож' });
    return { s, ...r };
  }

  it('twice → second cached:true, one generations row', async () => {
    const { s, projectId } = await ready();
    const a = await s.caller.publish.generateMeta({ projectId, language: 'uk' });
    const b = await s.caller.publish.generateMeta({ projectId, language: 'uk' });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.variants).toEqual(a.variants);
    expect(await genCount(s, projectId)).toHaveLength(1);
  });

  it('force → new generation', async () => {
    const { s, projectId } = await ready();
    await s.caller.publish.generateMeta({ projectId, language: 'uk' });
    const b = await s.caller.publish.generateMeta({ projectId, language: 'uk', force: true });
    expect(b.cached).toBe(false);
    expect(await genCount(s, projectId)).toHaveLength(2);
  });

  it('project without voice lines uses title and topic', async () => {
    const { s, projectId } = await ready();
    const r = await s.caller.publish.generateMeta({ projectId, language: 'uk' });
    expect(r.variants.youtube.title).toContain('Космічна подорож');
    expect(r.variants.youtube.description).not.toBe('');
    expect(r.variants.tiktok.title).toBe('');
  });

  it('youtube variant passes validateMeta and has defaults', async () => {
    const { s, projectId } = await ready();
    const { variants } = await s.caller.publish.generateMeta({ projectId, language: 'uk' });
    expect(validateMeta('youtube', variants.youtube)).toEqual([]);
    expect(variants.youtube).toMatchObject({ privacy: 'public', madeForKids: false, categoryId: '22' });
  });

  it('records cost on the generation and ignores foreign voice lines', async () => {
    const { s, projectId } = await ready();
    await s.deps.db
      .insert(voiceLines)
      .values({ userId: s.userId, projectId, segmentId: 'gone', language: 'uk', text: 'зайвий' });
    const r = await s.caller.publish.generateMeta({ projectId, language: 'uk' });
    expect(r.model).toBe('fake/text');
    expect((await genCount(s, projectId))[0]).toMatchObject({ status: 'done', capability: 'text' });
  });

  it('without default text model → VALIDATION', async () => {
    const s = await start();
    const { projectId } = await makeRender(s);
    await s.deps.db.update(userSettings).set({ defaults: {} }).where(eq(userSettings.userId, s.userId));
    await expect(s.caller.publish.generateMeta({ projectId, language: 'uk' })).rejects.toThrow(
      'Оберіть модель для тексту в налаштуваннях',
    );
  });
});
