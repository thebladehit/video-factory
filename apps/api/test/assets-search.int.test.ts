import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assets, generations, users } from '@vf/db';
import { appRouter, type AppDeps } from '../src/index';
import { startApp } from './helpers';

type Caller = ReturnType<typeof appRouter.createCaller>;
let deps: AppDeps;
let userId: string;
let caller: Caller;

beforeEach(async () => {
  ({ deps } = await startApp());
  const [u] = await deps.db.insert(users).values({ name: 'Пошук' }).returning();
  userId = u!.id;
  caller = appRouter.createCaller({ userId, deps });
});
afterEach(() => deps.db.delete(users).where(eq(users.id, userId)));

let seq = 0;
async function seed(row: Partial<typeof assets.$inferInsert> = {}) {
  seq++;
  const id = crypto.randomUUID();
  const createdAt = new Date(Date.UTC(2026, 0, 1) + seq * 1000);
  await deps.db.insert(assets).values({
    id,
    userId,
    kind: 'image',
    source: 'uploaded',
    status: 'ready',
    storageKey: `u/${userId}/assets/${id}/original.png`,
    mime: 'image/png',
    width: 100,
    height: 100,
    createdAt,
    ...row,
  });
  return id;
}

const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);

describe('assets.list', () => {
  it('empty query lists newest first and only ready', async () => {
    const a = await seed({ title: 'перший' });
    const b = await seed({ title: 'другий' });
    await seed({ title: 'в обробці', status: 'processing' });
    await seed({ title: 'зламаний', status: 'failed' });
    expect(ids(await caller.assets.list({}))).toEqual([b, a]);
  });

  it('finds by title word, by tag and by prompt word', async () => {
    const t = await seed({ title: 'Захід сонця над морем' });
    const g = await seed({ title: 'x', tags: ['котик', 'cat'] });
    const p = await seed({ title: 'y', source: 'generated', prompt: 'кіт у космосі' });
    expect(ids(await caller.assets.list({ q: 'морем' }))).toEqual([t]);
    expect(ids(await caller.assets.list({ q: 'cat' }))).toEqual([g]);
    expect(ids(await caller.assets.list({ q: 'космосі' }))).toEqual([p]);
  });

  it('finds with a typo via trigram', async () => {
    const cat = await seed({ title: 'x', tags: ['котик'] });
    const sun = await seed({ title: 'Sunset' });
    expect(ids(await caller.assets.list({ q: 'котк' }))).toContain(cat);
    expect(ids(await caller.assets.list({ q: 'Sunst' }))).toContain(sun);
  });

  it('ranks exact matches above fuzzy', async () => {
    const fuzzy = await seed({ title: 'Sunsets' });
    const exact = await seed({ title: 'sunset' });
    expect(ids(await caller.assets.list({ q: 'sunset' }))[0]).toBe(exact);
    expect(ids(await caller.assets.list({ q: 'sunset' }))).toContain(fuzzy);
  });

  it('filters by kind, source, orientation and tags (all must match)', async () => {
    const v = await seed({ kind: 'video', mime: 'video/mp4', width: 1080, height: 1920, tags: ['a', 'b'] });
    const h = await seed({ width: 1920, height: 1080, source: 'generated', tags: ['a'] });
    const s = await seed({ width: 500, height: 500 });
    expect(ids(await caller.assets.list({ kind: 'video' }))).toEqual([v]);
    expect(ids(await caller.assets.list({ source: 'generated' }))).toEqual([h]);
    expect(ids(await caller.assets.list({ orientation: 'vertical' }))).toEqual([v]);
    expect(ids(await caller.assets.list({ orientation: 'horizontal' }))).toEqual([h]);
    expect(ids(await caller.assets.list({ orientation: 'square' }))).toEqual([s]);
    expect(ids(await caller.assets.list({ tags: ['a', 'b'] }))).toEqual([v]);
    expect(ids(await caller.assets.list({ tags: ['a'] })).sort()).toEqual([v, h].sort());
  });

  it('special characters never throw', async () => {
    await seed({ title: "o'neil & co" });
    for (const q of ['"', "'", ':', '&', '!', '(', 'a & | b', '🐱', '   ', "o'neil", '\\', '%_', '<->']) {
      await expect(caller.assets.list({ q })).resolves.toHaveProperty('items');
    }
  });

  it('cursor pagination returns disjoint pages', async () => {
    const rows = Array.from({ length: 130 }, (_, i) => ({
      id: crypto.randomUUID(),
      userId,
      kind: 'image' as const,
      source: 'uploaded' as const,
      status: 'ready' as const,
      storageKey: `k/${crypto.randomUUID()}`,
      mime: 'image/png',
      title: `кадр ${i}`,
      tags: ['серія'],
      createdAt: new Date(Date.UTC(2026, 1, 1) + i * 1000),
    }));
    await deps.db.insert(assets).values(rows);
    for (const q of [undefined, 'серія']) {
      const seen: string[] = [];
      let cursor: string | undefined;
      const sizes: number[] = [];
      do {
        const page = await caller.assets.list({ q, cursor, limit: 60 });
        sizes.push(page.items.length);
        seen.push(...ids(page));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(sizes).toEqual([60, 60, 10]);
      expect(new Set(seen).size).toBe(130);
    }
  });

  it('isolates users', async () => {
    const mine = await seed({ title: 'секрет', tags: ['приватне'] });
    const { caller: other } = await startApp();
    expect(ids(await other.assets.list({ q: 'секрет' }))).not.toContain(mine);
    await expect(other.assets.get({ id: mine })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await other.assets.tags()).map((t) => t.tag)).not.toContain('приватне');
    expect((await other.assets.pending()).map((a) => a.id)).not.toContain(mine);
  });
});

describe('asset management', () => {
  it('get returns urls and generation info', async () => {
    const [gen] = await deps.db
      .insert(generations)
      .values({
        userId,
        capability: 'image',
        provider: 'fake',
        model: 'image',
        prompt: 'p',
        status: 'done',
        costEstimate: '0.04',
      })
      .returning();
    const id = await seed({ source: 'generated', generationId: gen!.id, thumbKey: 'k/thumb.webp' });
    const a = await caller.assets.get({ id });
    expect(a.url).toMatch(/^http/);
    expect(a.thumbUrl).toMatch(/^http/);
    expect(a.generation).toEqual({ model: 'fake/image', costEstimate: 0.04 });
  });

  it('update normalizes tags and search finds the new tag', async () => {
    const id = await seed({ title: 'без тегів' });
    const a = await caller.assets.update({ id, title: 'Новий заголовок', tags: [' Кіт ', 'кіт', 'Море'] });
    expect(a).toMatchObject({ title: 'Новий заголовок', tags: ['кіт', 'море'] });
    expect(ids(await caller.assets.list({ q: 'море' }))).toEqual([id]);
  });

  it('delete removes S3 objects and the row', async () => {
    const id = crypto.randomUUID();
    const key = `u/${userId}/assets/${id}/original.png`;
    const thumb = `u/${userId}/assets/${id}/thumb.webp`;
    await deps.storage.put(key, new Uint8Array([1]), { contentType: 'image/png' });
    await deps.storage.put(thumb, new Uint8Array([1]), { contentType: 'image/webp' });
    await seed({ id, storageKey: key, thumbKey: thumb });
    await caller.assets.delete({ id });
    expect(await deps.storage.head(key)).toBeNull();
    expect(await deps.storage.head(thumb)).toBeNull();
    await expect(caller.assets.get({ id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('pending lists uploading, processing and failed, newest first', async () => {
    const f = await seed({ status: 'failed', error: 'x' });
    const p = await seed({ status: 'processing' });
    await seed({ status: 'ready' });
    expect((await caller.assets.pending()).map((a) => a.id)).toEqual([p, f]);
  });

  it('topTags counts only ready assets of the user', async () => {
    await seed({ tags: ['море', 'сонце'] });
    await seed({ tags: ['море'] });
    await seed({ tags: ['море'], status: 'failed' });
    expect(await caller.assets.tags()).toEqual([
      { tag: 'море', count: 2 },
      { tag: 'сонце', count: 1 },
    ]);
  });
});
