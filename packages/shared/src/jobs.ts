export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['done', 'failed', 'cancelled']);

/** Розширюється в наступних підпроєктах. */
export type JobType =
  | 'debug.sleep'
  | 'asset.process'
  | 'image.generate'
  | 'video.generate'
  | 'assets.tag'
  | 'render'
  | 'asset.analyze'
  | 'voice.transcribe'
  | 'voice.translate'
  | 'voice.synthesize'
  | 'voice.synthesizeBatch'
  | 'pipeline.script'
  | 'pipeline.scene'
  | 'pipeline.visual'
  | 'pipeline.assemble';

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

/** Сутність, якої стосується задача (з payload) — щоб UI знав, що оновити. */
export interface JobSubject {
  assetId?: string;
  generationId?: string;
  renderId?: string;
  projectId?: string;
  lineId?: string;
  sceneId?: string;
}

export interface JobEvent {
  jobId: string;
  userId: string;
  type: JobType;
  subject: JobSubject;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
}

export function jobSubject(payload: unknown): JobSubject {
  const p = (payload ?? {}) as Record<string, unknown>;
  const subject: JobSubject = {};
  if (typeof p.assetId === 'string') subject.assetId = p.assetId;
  if (typeof p.generationId === 'string') subject.generationId = p.generationId;
  if (typeof p.renderId === 'string') subject.renderId = p.renderId;
  if (typeof p.projectId === 'string') subject.projectId = p.projectId;
  if (typeof p.lineId === 'string') subject.lineId = p.lineId;
  if (typeof p.sceneId === 'string') subject.sceneId = p.sceneId;
  return subject;
}

export const toJobEvent = (r: JobRecord): JobEvent => ({
  jobId: r.id,
  userId: r.userId,
  type: r.type,
  subject: jobSubject(r.payload),
  status: r.status,
  progress: r.progress,
  message: r.message,
  error: r.error,
});
