import type { JobEvent, JobRecord, JobStatus, JobType } from '@vf/shared';

export interface JobContext {
  jobId: string;
  userId: string;
  progress(pct: number, message?: string): Promise<void>;
  signal: AbortSignal;
}

export interface JobDef<P = unknown, R = unknown> {
  type: JobType;
  concurrency: number;
  handler(payload: P, ctx: JobContext): Promise<R>;
}

export interface JobQueue {
  enqueue<P>(type: JobType, payload: P, opts: { userId: string; priority?: number }): Promise<string>;
  /** Немає задачі → AppError('NOT_FOUND') */
  get(jobId: string): Promise<JobRecord>;
  cancel(jobId: string): Promise<void>;
  /** Нова задача з тим самим type/payload/userId; лише з failed|cancelled, інакше AppError('CONFLICT') */
  retry(jobId: string): Promise<string>;
  onEvent(listener: (e: JobEvent) => void): () => void;
}

export interface WorkerRuntime {
  register(def: JobDef<any, any>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface JobStore {
  insert(row: { userId: string; type: JobType; payload: unknown }): Promise<JobRecord>;
  /**
   * queued → running атомарно; null, якщо задача вже не queued.
   * Задачу з прапорцем скасування не бере, а переводить у cancelled.
   */
  claim(id: string): Promise<JobRecord | null>;
  /** Лише для running; null — задача вже не виконується (запізнілий прогрес ігнорується) */
  progress(id: string, pct: number, message: string | null): Promise<JobRecord | null>;
  /** Лише з running|queued; null — задача вже завершена */
  finish(
    id: string,
    status: 'done' | 'failed' | 'cancelled',
    fields: { result?: unknown; error?: string },
  ): Promise<JobRecord | null>;
  /** Ставить прапорець скасування для queued|running; null — задача вже завершена */
  requestCancel(id: string): Promise<JobRecord | null>;
  cancelRequested(id: string): Promise<boolean>;
  /** queued → cancelled атомарно; null, якщо задача вже не queued */
  cancelIfQueued(id: string): Promise<JobRecord | null>;
  get(id: string): Promise<JobRecord | null>;
  listByStatus(statuses: JobStatus[]): Promise<JobRecord[]>;
}
