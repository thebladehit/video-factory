import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { jobs, type Db } from '@vf/db';
import type { JobRecord, JobType } from '@vf/shared';
import type { JobStore } from './types';

type Row = typeof jobs.$inferSelect;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const toRecord = (r: Row): JobRecord => ({
  id: r.id,
  userId: r.userId,
  type: r.type as JobType,
  payload: r.payload,
  status: r.status,
  progress: r.progress,
  message: r.message,
  error: r.error,
  attempts: r.attempts,
  result: r.result,
  createdAt: r.createdAt.toISOString(),
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
});

export function createPgJobStore(db: Db): JobStore {
  const one = (rows: Row[]) => {
    if (!rows[0]) throw new Error('job row not returned');
    return toRecord(rows[0]);
  };
  return {
    async insert({ userId, type, payload }) {
      return one(await db.insert(jobs).values({ userId, type, payload }).returning());
    },
    async claim(id) {
      const rows = await db
        .update(jobs)
        .set({ status: 'running', startedAt: new Date(), attempts: sql`${jobs.attempts} + 1` })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'queued'), eq(jobs.cancelRequested, false)))
        .returning();
      if (rows[0]) return toRecord(rows[0]);
      await db
        .update(jobs)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'queued'), eq(jobs.cancelRequested, true)));
      return null;
    },
    async progress(id, pct, message) {
      const rows = await db
        .update(jobs)
        .set({ progress: pct, message })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'running')))
        .returning();
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async finish(id, status, { result, error }) {
      const rows = await db
        .update(jobs)
        .set({
          status,
          result: result ?? null,
          error: error ?? null,
          finishedAt: new Date(),
          ...(status === 'done' ? { progress: 100 } : {}),
        })
        .where(and(eq(jobs.id, id), inArray(jobs.status, ['running', 'queued'])))
        .returning();
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async requestCancel(id) {
      const rows = await db
        .update(jobs)
        .set({ cancelRequested: true })
        .where(and(eq(jobs.id, id), inArray(jobs.status, ['running', 'queued'])))
        .returning();
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async cancelRequested(id) {
      const rows = await db.select({ c: jobs.cancelRequested }).from(jobs).where(eq(jobs.id, id));
      return rows[0]?.c ?? false;
    },
    async cancelIfQueued(id) {
      const rows = await db
        .update(jobs)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'queued')))
        .returning();
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async get(id) {
      const rows = await db.select().from(jobs).where(eq(jobs.id, id));
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async listByStatus(statuses) {
      const rows = await db.select().from(jobs).where(inArray(jobs.status, statuses)).orderBy(asc(jobs.createdAt));
      return rows.map(toRecord);
    },
  };
}
