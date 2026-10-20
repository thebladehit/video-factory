export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['done', 'failed', 'cancelled']);

/** Розширюється в наступних підпроєктах. */
export type JobType = 'debug.sleep';

export interface JobRecord {
  id: string;
  userId: string;
  type: JobType;
  payload: unknown;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  attempts: number;
  result: unknown;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobEvent {
  jobId: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
}
