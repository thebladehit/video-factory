import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assets, jobs, users } from '@vf/db';
import { appRouter } from '../src/index';
import { pngBytes, upload } from './assets-helpers';
import { startApp } from './helpers';

const MB = 1024 ** 2;

describe('assets upload', () => {
  it('single upload: createUpload → PUT → complete → processing and job enqueued', async () => {
    const { caller, deps } = await startApp();
    const bytes = await pngBytes();
    const ticket = await caller.assets.createUpload({ name: 'кіт.png', mime: 'image/png', size: bytes.length });
    expect(ticket.mode).toBe('single');
    if (ticket.mode !== 'single') return;
    const put = await fetch(ticket.url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
    expect(put.ok).toBe(true);
    const res = await caller.assets.complete({ assetId: ticket.assetId });
    expect(['processing', 'ready']).toContain(res.status);
    const queued = await deps.db.select().from(jobs).where(eq(jobs.type, 'asset.process'));
    expect(queued.some((j) => (j.payload as { assetId: string }).assetId === ticket.assetId)).toBe(true);
    const [row] = await deps.db.select().from(assets).where(eq(assets.id, ticket.assetId));
    expect(row).toMatchObject({ title: 'кіт', originalName: 'кіт.png', source: 'uploaded', kind: 'image' });
  });

  it('multipart upload of a 70 MB file', async () => {
    const { caller } = await startApp();
    const size = 70 * MB;
    const ticket = await caller.assets.createUpload({ name: 'big.mp4', mime: 'video/mp4', size });
    expect(ticket).toMatchObject({ mode: 'multipart', partSize: 16 * MB });
    if (ticket.mode !== 'multipart') return;
    const partNumbers = [1, 2, 3, 4, 5];
    const urls = await caller.assets.signParts({ assetId: ticket.assetId, partNumbers });
    const parts = [];
    for (const { partNumber, url } of urls) {
      const len = partNumber < 5 ? ticket.partSize : size - 4 * ticket.partSize;
      const res = await fetch(url, { method: 'PUT', body: new Uint8Array(len) });
      expect(res.ok).toBe(true);
      parts.push({ PartNumber: partNumber, ETag: res.headers.get('etag')! });
    }
    expect(await caller.assets.listParts({ assetId: ticket.assetId })).toHaveLength(5);
    expect((await caller.assets.complete({ assetId: ticket.assetId, parts })).status).toMatch(
      /processing|ready|failed/,
    );
  }, 60_000);

  it('complete is idempotent', async () => {
    const { caller, deps } = await startApp();
    const id = await upload(caller, 'twice.png', 'image/png', await pngBytes());
    await caller.assets.complete({ assetId: id });
    const queued = await deps.db.select().from(jobs).where(eq(jobs.type, 'asset.process'));
    expect(queued.filter((j) => (j.payload as { assetId: string }).assetId === id)).toHaveLength(1);
  });

  it('two uploads with the same name get different keys', async () => {
    const { caller, deps } = await startApp();
    const bytes = await pngBytes();
    const [a, b] = await Promise.all([
      upload(caller, 'same.png', 'image/png', bytes),
      upload(caller, 'same.png', 'image/png', bytes),
    ]);
    expect(a).not.toBe(b);
    const rows = await deps.db
      .select()
      .from(assets)
      .where(and(eq(assets.originalName, 'same.png')));
    const keys = rows.filter((r) => r.id === a || r.id === b).map((r) => r.storageKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('complete without an uploaded object is VALIDATION and keeps uploading', async () => {
    const { caller, deps } = await startApp();
    const t = await caller.assets.createUpload({ name: 'ghost.png', mime: 'image/png', size: 100 });
    await expect(caller.assets.complete({ assetId: t.assetId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const [row] = await deps.db.select().from(assets).where(eq(assets.id, t.assetId));
    expect(row!.status).toBe('uploading');
  });

  it('complete with a size mismatch is VALIDATION', async () => {
    const { caller } = await startApp();
    const t = await caller.assets.createUpload({ name: 'liar.png', mime: 'image/png', size: 1000 });
    if (t.mode !== 'single') return;
    await fetch(t.url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array(10) });
    await expect(caller.assets.complete({ assetId: t.assetId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('розмір'),
    });
  });

  it('foreign asset is NOT_FOUND', async () => {
    const { caller, deps } = await startApp();
    const [stranger] = await deps.db.insert(users).values({ name: 'Інший' }).returning();
    const other = appRouter.createCaller({ userId: stranger!.id, deps });
    const t = await caller.assets.createUpload({ name: 'mine.png', mime: 'image/png', size: 100 });
    await expect(other.assets.signParts({ assetId: t.assetId, partNumbers: [1] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(other.assets.complete({ assetId: t.assetId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.assets.abort({ assetId: t.assetId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller.assets.complete({ assetId: 'not-a-uuid' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await deps.db.delete(users).where(eq(users.id, stranger!.id));
  });

  it('abort removes the row and the multipart upload', async () => {
    const { caller, deps } = await startApp();
    const t = await caller.assets.createUpload({ name: 'big.webm', mime: 'video/webm', size: 100 * MB });
    if (t.mode !== 'multipart') throw new Error('expected multipart');
    const [row] = await deps.db.select().from(assets).where(eq(assets.id, t.assetId));
    await caller.assets.abort({ assetId: t.assetId });
    expect(await deps.db.select().from(assets).where(eq(assets.id, t.assetId))).toHaveLength(0);
    await expect(deps.storage.listParts(row!.storageKey, t.uploadId)).rejects.toThrow();
  });

  it('createUpload rejects a too large file before touching S3', async () => {
    const { caller, deps } = await startApp();
    const before = (await deps.db.select().from(assets)).length;
    await expect(
      caller.assets.createUpload({ name: 'huge.png', mime: 'image/png', size: 51 * MB }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('50 МБ') });
    expect((await deps.db.select().from(assets)).length).toBe(before);
  });
});
