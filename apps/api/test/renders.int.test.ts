import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assets, jobs, renders } from '@vf/db';
import { RESTART_ERROR } from '@vf/jobs';
import { LOCAL_USER_ID, type TimelineDoc } from '@vf/shared';
import { addClip } from '@vf/timeline';
import { appRouter } from '../src/index';
import { renderJob } from '../src/modules/renders/render-job';
import { pngBytes, toneMp4Bytes, upload, waitForAsset } from './assets-helpers';
import { startApp } from './helpers';

type Started = Awaited<ReturnType<typeof startApp>>;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Проєкт з фото (1 с) і відео з тоном (1 с), збережений. */
async function project(s: Started, opts: { photoSec?: number; title?: string } = {}) {
  const photo = await upload(s.caller, 'p.png', 'image/png', await pngBytes(320, 240, '#ff0000'));
  const video = await upload(s.caller, 'v.mp4', 'video/mp4', await toneMp4Bytes(1));
  await waitForAsset(s.deps, photo, ['ready']);
  const v = await waitForAsset(s.deps, video, ['ready']);
  const { id } = await s.caller.projects.create({ title: opts.title ?? 'Ролик', format: '9:16' });
  let doc: TimelineDoc = (await s.caller.projects.get({ id })).timeline;
  doc = addClip(doc, { id: photo, kind: 'image' }, { at: 0 }).doc;
  doc = {
    ...doc,
    tracks: doc.tracks.map((t) =>
      t.kind === 'video' ? { ...t, clips: t.clips.map((c) => ({ ...c, duration: opts.photoSec ?? 1 })) } : t,
    ),
  } as TimelineDoc;
  doc = addClip(
    doc,
    { id: video, kind: 'video', durationSec: v.durationMs! / 1000, hasAudio: true },
    { at: opts.photoSec ?? 1 },
  ).doc;
  const { version } = await s.caller.projects.save({ id, timeline: doc, baseVersion: 1 });
  return { id, version, photo, video, doc };
}

const jobOf = async (s: Started, renderId: string) => {
  const [r] = await s.deps.db.select().from(renders).where(eq(renders.id, renderId));
  return r!.jobId ? (await s.deps.db.select().from(jobs).where(eq(jobs.id, r!.jobId)))[0]! : null;
};

const noopCtx = () => ({
  jobId: randomUUID(),
  userId: LOCAL_USER_ID,
  progress: async () => {},
  signal: new AbortController().signal,
});

describe('renders.start validation', () => {
  it('start on an empty timeline → VALIDATION', async () => {
    const { caller } = await startApp();
    const { id } = await caller.projects.create({ title: 'P', format: '9:16' });
    await expect(caller.renders.start({ projectId: id, preset: 'draft', version: 1 })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'VALIDATION' }),
    });
  });

  it('start with a deleted asset → VALIDATION with details.clipIds', async () => {
    const s = await startApp();
    const p = await project(s);
    await s.caller.assets.delete({ id: p.photo });
    const err = await s.caller.renders.start({ projectId: p.id, preset: 'draft', version: p.version }).catch((e) => e);
    expect(err.cause).toMatchObject({ code: 'VALIDATION', details: { clipIds: [p.doc.tracks[0]!.clips[0]!.id] } });
  }, 60_000);

  it('start with a processing asset → VALIDATION', async () => {
    const s = await startApp();
    const p = await project(s);
    await s.deps.db.update(assets).set({ status: 'processing' }).where(eq(assets.id, p.video));
    await expect(
      s.caller.renders.start({ projectId: p.id, preset: 'draft', version: p.version }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'VALIDATION' }),
    });
  }, 60_000);

  it('start with a stale version → CONFLICT', async () => {
    const s = await startApp();
    const p = await project(s);
    await expect(
      s.caller.renders.start({ projectId: p.id, preset: 'draft', version: p.version - 1 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 60_000);
});

describe('render job', () => {
  it('produces a ready rendered asset with id = renderId, title "{project} — …", thumbnail and duration', async () => {
    const s = await startApp();
    const p = await project(s, { title: 'Мій ролик' });
    const { renderId } = await s.caller.renders.start({ projectId: p.id, preset: 'draft', version: p.version });
    const a = await waitFor(async () => {
      const [r] = await s.deps.db.select().from(assets).where(eq(assets.id, renderId));
      return r?.status === 'ready' ? r : null;
    }, 60_000);
    expect(a).toMatchObject({
      source: 'rendered',
      kind: 'video',
      width: 720,
      height: 1280,
      mime: 'video/mp4',
      hasAudio: true,
    });
    expect(a.title).toMatch(/^Мій ролик — /);
    expect(a.thumbKey).not.toBeNull();
    expect(Math.abs(a.durationMs! - 2000)).toBeLessThanOrEqual(70);
    const [r] = await s.deps.db.select().from(renders).where(eq(renders.id, renderId));
    expect(r).toMatchObject({ status: 'done', outputAssetId: renderId });
  }, 90_000);

  it('list shows progress then output with downloadUrl', async () => {
    const s = await startApp();
    const p = await project(s);
    const { renderId } = await s.caller.renders.start({ projectId: p.id, preset: 'draft', version: p.version });
    const first = await s.caller.renders.list({ projectId: p.id });
    expect(first[0]).toMatchObject({ id: renderId, preset: 'draft', output: null });
    expect(['queued', 'running']).toContain(first[0]!.status);
    const done = await waitFor(async () => {
      const [v] = await s.caller.renders.list({ projectId: p.id });
      return v?.output?.status === 'ready' ? v : null;
    }, 60_000);
    expect(done).toMatchObject({ status: 'done', progress: 100, output: { assetId: renderId } });
    expect(done.output!.downloadUrl).toContain('original.mp4');
    expect(done.output!.durationMs).toBeGreaterThan(1900);
  }, 90_000);

  it('retry after failure does not duplicate the asset', async () => {
    const s = await startApp();
    const p = await project(s);
    const { renderId } = await s.caller.renders.start({ projectId: p.id, preset: 'draft', version: p.version });
    await waitFor(async () => (await s.deps.db.select().from(assets).where(eq(assets.id, renderId)))[0], 60_000);
    const job = renderJob(s.deps);
    await job.handler({ renderId }, noopCtx());
    await job.handler({ renderId }, noopCtx());
    const rows = await s.deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from assets where id = ${renderId}`,
    );
    expect(rows[0]!.n).toBe(1);
  }, 90_000);

  it('cancel during ffmpeg ends cancelled, no asset and no temp dir left', async () => {
    const s = await startApp();
    const p = await project(s, { photoSec: 30 });
    const { renderId } = await s.caller.renders.start({ projectId: p.id, preset: 'final', version: p.version });
    await waitFor(async () => {
      const j = await jobOf(s, renderId);
      return j?.status === 'running' && j.progress > 1;
    }, 60_000);
    await s.caller.renders.cancel({ id: renderId });
    await waitFor(async () => (await jobOf(s, renderId))?.status === 'cancelled');
    const [view] = await s.caller.renders.list({ projectId: p.id });
    expect(view).toMatchObject({ status: 'cancelled', output: null });
    expect((await s.deps.db.select().from(assets).where(eq(assets.id, renderId))).length).toBe(0);
    expect((await readdir(tmpdir())).filter((d) => d.startsWith(`vf-render-${renderId.slice(0, 8)}`))).toEqual([]);
  }, 90_000);

  it('asset deleted while rendering → failed "Файл «…» видалено з бібліотеки"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vf-slow-'));
    const slow = join(dir, 'ffmpeg');
    // повільний лише рендер (у нього є -progress), обробка файлів — звичайна
    await writeFile(slow, '#!/bin/sh\ncase "$*" in *-progress*) sleep 2;; esac\nexec ffmpeg "$@"\n');
    await chmod(slow, 0o755);
    const s = await startApp({ ffmpegPath: slow });
    const p = await project(s);
    const { renderId } = await s.caller.renders.start({ projectId: p.id, preset: 'draft', version: p.version });
    await waitFor(async () => (await jobOf(s, renderId))?.status === 'running');
    await new Promise((r) => setTimeout(r, 600));
    await s.caller.assets.delete({ id: p.photo });
    const job = await waitFor(async () => {
      const j = await jobOf(s, renderId);
      return j?.status === 'failed' ? j : null;
    });
    expect(job.error).toMatch(/Файл «.+» видалено з бібліотеки/);
    const [view] = await s.caller.renders.list({ projectId: p.id });
    expect(view).toMatchObject({ status: 'failed', output: null });
    expect(view!.error).toMatch(/видалено з бібліотеки/);
    expect((await s.deps.db.select().from(assets).where(eq(assets.id, renderId))).length).toBe(0);
  }, 90_000);

  it('restart-interrupted render is shown failed and retry works', async () => {
    const s = await startApp();
    const p = await project(s);
    const [r] = await s.deps.db
      .insert(renders)
      .values({
        userId: LOCAL_USER_ID,
        projectId: p.id,
        preset: 'draft',
        timelineSnapshot: p.doc,
        timelineVersion: p.version,
        status: 'running',
      })
      .returning();
    const [j] = await s.deps.db
      .insert(jobs)
      .values({
        userId: LOCAL_USER_ID,
        type: 'render',
        payload: { renderId: r!.id },
        status: 'failed',
        error: RESTART_ERROR,
      })
      .returning();
    await s.deps.db.update(renders).set({ jobId: j!.id }).where(eq(renders.id, r!.id));
    const [view] = await s.caller.renders.list({ projectId: p.id });
    expect(view).toMatchObject({ id: r!.id, status: 'failed', error: RESTART_ERROR });
    await s.caller.renders.retry({ id: r!.id });
    await waitFor(async () => (await s.deps.db.select().from(assets).where(eq(assets.id, r!.id)))[0], 60_000);
  }, 90_000);

  it('foreign project/render → NOT_FOUND', async () => {
    const s = await startApp();
    const p = await project(s);
    const { renderId } = await s.caller.renders.start({ projectId: p.id, preset: 'draft', version: p.version });
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(
      stranger.renders.start({ projectId: p.id, preset: 'draft', version: p.version }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(stranger.renders.list({ projectId: p.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(stranger.renders.cancel({ id: renderId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(stranger.renders.retry({ id: renderId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);

  it('deleting a project keeps the rendered asset', async () => {
    const s = await startApp();
    const p = await project(s);
    const { renderId } = await s.caller.renders.start({ projectId: p.id, preset: 'draft', version: p.version });
    await waitFor(
      async () => (await s.deps.db.select().from(assets).where(eq(assets.id, renderId)))[0]?.status === 'ready',
      60_000,
    );
    await s.caller.projects.delete({ id: p.id });
    expect((await s.deps.db.select().from(assets).where(eq(assets.id, renderId))).length).toBe(1);
  }, 90_000);
});
