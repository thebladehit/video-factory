import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_USER_ID } from '@vf/shared';
import { assets, createDb, jobs, runMigrations, seed, users } from './index';

const url = process.env.TEST_DATABASE_URL!;
const { db, close } = createDb(url);

beforeAll(async () => {
  await runMigrations(url);
  await seed(db);
  await seed(db);
});
afterAll(() => close());

describe('db', () => {
  it('seed is idempotent and creates the local user', async () => {
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(LOCAL_USER_ID);
  });

  it('jobs.status check constraint rejects unknown status', async () => {
    await expect(
      db.insert(jobs).values({ userId: LOCAL_USER_ID, type: 'debug.sleep', payload: {}, status: 'weird' as never }),
    ).rejects.toThrow();
  });

  describe('assets search', () => {
    let id: string;
    beforeAll(async () => {
      const [row] = await db
        .insert(assets)
        .values({
          userId: LOCAL_USER_ID,
          kind: 'image',
          source: 'generated',
          storageKey: `test/${crypto.randomUUID()}.png`,
          mime: 'image/png',
          title: 'Захід сонця над морем',
          tags: ['beach', 'sunset'],
          prompt: 'golden hour ocean',
        })
        .returning({ id: assets.id });
      id = row!.id;
    });
    afterAll(() => db.delete(assets).where(sql`${assets.id} = ${id}`));

    const search = (q: string) =>
      db
        .select({ id: assets.id })
        .from(assets)
        .where(sql`${assets.search} @@ websearch_to_tsquery('simple', ${q}) and ${assets.id} = ${id}`);

    it.each(['sunset', 'Захід', 'ocean'])('full-text finds by %s', async (q) => {
      expect(await search(q)).toHaveLength(1);
    });

    it('full-text does not match unrelated word', async () => {
      expect(await search('mountain')).toHaveLength(0);
    });

    it('trigram matches a misspelled title', async () => {
      const rows = await db.execute<{ s: number }>(
        sql`select similarity(${assets.title}, 'Захид сонця') as s from ${assets} where ${assets.id} = ${id}`,
      );
      expect(Number(rows[0]!.s)).toBeGreaterThan(0.3);
    });
  });

  describe('library columns', () => {
    const base = () => ({
      userId: LOCAL_USER_ID,
      kind: 'image' as const,
      source: 'uploaded' as const,
      storageKey: `test/${crypto.randomUUID()}.png`,
      mime: 'image/png',
    });

    it('asset status defaults to ready and rejects unknown values', async () => {
      const [row] = await db.insert(assets).values(base()).returning();
      expect(row!.status).toBe('ready');
      await expect(db.insert(assets).values({ ...base(), status: 'bogus' as never })).rejects.toThrow();
      await db.delete(assets).where(sql`${assets.id} = ${row!.id}`);
    });

    it('trigram on tags finds a typo', async () => {
      const [row] = await db
        .insert(assets)
        .values({ ...base(), tags: ['котик'] })
        .returning();
      const found = await db
        .select({ id: assets.id })
        .from(assets)
        .where(sql`similarity(vf_tags_text(${assets.tags}), 'котк') > 0.3`);
      expect(found.map((r) => r.id)).toContain(row!.id);
      await db.delete(assets).where(sql`${assets.id} = ${row!.id}`);
    });
  });
});
