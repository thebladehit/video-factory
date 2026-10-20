import PQueue from 'p-queue';
import { AppError, TERMINAL_STATUSES, type JobEvent, type JobRecord, type JobType } from '@vf/shared';
import { assertSerializablePayload } from './serializable';
import type { JobDef, JobQueue, JobStore, WorkerRuntime } from './types';

const RESTART_ERROR = 'Перервано перезапуском сервера';
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Черга задач в тому ж процесі. Стан — у JobStore (Postgres), тож після рестарту
 * незавершені задачі відновлюються. Замінюється на BullMQ без змін у обробниках.
 */
export function createInProcessJobs(store: JobStore): { queue: JobQueue; runtime: WorkerRuntime } {
  const defs = new Map<JobType, JobDef<any, any>>();
  const queues = new Map<JobType, PQueue>();
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<(e: JobEvent) => void>();
  let started = false;

  const emit = (r: JobRecord) => {
    const e: JobEvent = { jobId: r.id, status: r.status, progress: r.progress, message: r.message, error: r.error };
    for (const l of listeners) l(e);
  };

  const pqueueFor = (type: JobType) => {
    let q = queues.get(type);
    if (!q) {
      q = new PQueue({ concurrency: defs.get(type)!.concurrency });
      queues.set(type, q);
    }
    return q;
  };

  const schedule = (r: JobRecord) => void pqueueFor(r.type).add(() => execute(r.id));

  async function execute(id: string) {
    const claimed = await store.claim(id);
    if (!claimed) return;
    emit(claimed);
    const def = defs.get(claimed.type)!;
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    try {
      const result = await def.handler(claimed.payload, {
        jobId: id,
        userId: claimed.userId,
        signal: ctrl.signal,
        progress: async (pct, message) => {
          if (ctrl.signal.aborted) return;
          emit(await store.progress(id, Math.min(100, Math.max(0, pct)), message ?? null));
        },
      });
      emit(await store.finish(id, ctrl.signal.aborted ? 'cancelled' : 'done', { result }));
    } catch (e) {
      emit(await store.finish(id, ctrl.signal.aborted ? 'cancelled' : 'failed', { error: errorMessage(e) }));
    } finally {
      controllers.delete(id);
    }
  }

  const getOrThrow = async (id: string) => {
    const r = isUuid(id) ? await store.get(id) : null;
    if (!r) throw new AppError('NOT_FOUND', `Задачу не знайдено: ${id}`, { jobId: id });
    return r;
  };

  const queue: JobQueue = {
    async enqueue(type, payload, { userId }) {
      if (!defs.has(type)) throw new AppError('UNKNOWN_JOB_TYPE', `Невідомий тип задачі: ${type}`, { type });
      assertSerializablePayload(payload);
      const r = await store.insert({ userId, type, payload });
      emit(r);
      if (started) schedule(r);
      return r.id;
    },
    get: getOrThrow,
    async cancel(id) {
      const r = await getOrThrow(id);
      if (TERMINAL_STATUSES.has(r.status)) return;
      const cancelled = await store.cancelIfQueued(id);
      if (cancelled) return emit(cancelled);
      controllers.get(id)?.abort();
    },
    async retry(id) {
      const r = await getOrThrow(id);
      if (r.status !== 'failed' && r.status !== 'cancelled') {
        throw new AppError('CONFLICT', 'Повторити можна лише задачу з помилкою або скасовану', { status: r.status });
      }
      return queue.enqueue(r.type, r.payload, { userId: r.userId });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const runtime: WorkerRuntime = {
    register(def) {
      defs.set(def.type, def);
    },
    async start() {
      for (const r of await store.listByStatus(['running'])) {
        emit(await store.finish(r.id, 'failed', { error: RESTART_ERROR }));
      }
      started = true;
      for (const r of await store.listByStatus(['queued'])) {
        if (defs.has(r.type)) schedule(r);
      }
    },
    async stop() {
      started = false;
      for (const q of queues.values()) q.clear();
      for (const c of controllers.values()) c.abort();
      await Promise.all([...queues.values()].map((q) => q.onIdle()));
    },
  };

  return { queue, runtime };
}
