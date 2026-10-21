import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assets, users } from '@vf/db';
import type { AppDeps } from '../src/index';
import { matchAssets, LIBRARY_MATCH_MIN } from '../src/modules/assets/match';
import { startApp } from './helpers';

let deps: AppDeps;
let userId: string;
beforeEach(async () => {
  ({ deps } = await startApp());
  const [u] = await deps.db.insert(users).values({ name: 'Підбір' }).returning();
  userId = u!.id;
});
afterEach(() => deps.db.delete(users).where(eq(users.id, userId)));

async function seed(row: Partial<typeof assets.$inferInsert>, owner = userId) {
  const id = crypto.randomUUID();
  await deps.db.insert(assets).values({
    id,
    userId: owner,
    kind: 'image',
    source: 'uploaded',
    status: 'ready',
    storageKey: `u/${owner}/assets/${id}/original.png`,
    mime: 'image/png',
    width: 1080,
    height: 1920,
    ...row,
  });
  return id;
}

async function fixture() {
  const sunset = await seed({ title: 'Захід сонця над морем', tags: ['море', 'захід'] });
  const cat = await seed({ title: 'Кіт на дивані' });
  const mountains = await seed({ title: 'Гори взимку', width: 1920, height: 1080 });
  const audio = await seed({ title: 'Море шумить', kind: 'audio', width: null, height: null, mime: 'audio/mpeg' });
  const processing = await seed({ title: 'Море', tags: ['море'], status: 'processing' });
  return { sunset, cat, mountains, audio, processing };
}
const run = (keywords: string[], format: '9:16' | '16:9' = '9:16', exclude: string[] = []) =>
  matchAssets(deps, userId, { keywords, format, exclude });

describe('matchAssets', () => {
  it('strong match for keywords scores >= LIBRARY_MATCH_MIN', async () => {
    const f = await fixture();
    const r = await run(['море', 'захід сонця']);
    console.log('scores море+захід сонця', r.map((m) => [m.assetId === f.sunset ? 'sunset' : m.assetId, m.score]));
    expect(r[0]!.assetId).toBe(f.sunset);
    expect(r[0]!.score).toBeGreaterThanOrEqual(LIBRARY_MATCH_MIN);
    expect(r[0]).toMatchObject({ kind: 'image', width: 1080, height: 1920, durationMs: null });
  });

  it('unrelated keywords score below LIBRARY_MATCH_MIN', async () => {
    await fixture();
    const r = await run(['космос']);
    console.log('scores космос', r.map((m) => m.score));
    for (const m of r) expect(m.score).toBeLessThan(LIBRARY_MATCH_MIN);
  });

  it('horizontal asset excluded for 9:16, square allowed', async () => {
    const f = await fixture();
    const sq = await seed({ title: 'Гори квадрат', width: 500, height: 500 });
    const v = await run(['гори']);
    expect(v.map((m) => m.assetId)).toContain(sq);
    expect(v.map((m) => m.assetId)).not.toContain(f.mountains);
    const h = await run(['гори'], '16:9');
    expect(h.map((m) => m.assetId)).toEqual(expect.arrayContaining([sq, f.mountains]));
    expect(h.map((m) => m.assetId)).not.toContain(f.sunset);
  });

  it('audio and processing assets never returned', async () => {
    const f = await fixture();
    const ids = (await run(['море'])).map((m) => m.assetId);
    expect(ids).not.toContain(f.audio);
    expect(ids).not.toContain(f.processing);
  });

  it('exclude list skips an asset', async () => {
    const f = await fixture();
    const ids = (await run(['море'], '9:16', [f.sunset])).map((m) => m.assetId);
    expect(ids).not.toContain(f.sunset);
  });

  it("other user's assets never returned", async () => {
    const [o] = await deps.db.insert(users).values({ name: 'Чужий' }).returning();
    try {
      await seed({ title: 'Захід сонця над морем', tags: ['море'] }, o!.id);
      expect(await run(['море'])).toEqual([]);
    } finally {
      await deps.db.delete(users).where(eq(users.id, o!.id));
    }
  });
});
