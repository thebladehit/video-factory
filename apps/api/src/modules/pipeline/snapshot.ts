import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { assets, generations, jobs, pipelineRuns, pipelineScenes, projects, voiceLines } from '@vf/db';
import { normalizeDoc, type JobStatus } from '@vf/shared';
import type { AppDeps } from '../../app';
import type { ProjectRow } from '../projects/service';
import { projectLanguages } from '../voice/service';
import type { LangSnap, RunSnap, SceneSnap } from './advance';

export type RunRow = typeof pipelineRuns.$inferSelect;
export type SceneRow = typeof pipelineScenes.$inferSelect;

export interface LoadedRun {
  run: RunRow;
  project: ProjectRow;
  scenes: SceneRow[];
  snap: RunSnap;
}

/** Статуси задач за id; задачі, якої вже немає в БД, у мапі немає. */
async function jobStatuses(deps: AppDeps, ids: (string | null)[]): Promise<Map<string, JobStatus>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await deps.db.select({ id: jobs.id, status: jobs.status }).from(jobs).where(inArray(jobs.id, wanted));
  return new Map(rows.map((r) => [r.id, r.status]));
}

/** Стан перекладу мови: жива задача → live; текст для всіх сегментів → done; інакше — за останньою задачею. */
function translateState(live: JobStatus | undefined, covered: boolean): LangSnap['translate'] {
  if (live === 'queued' || live === 'running') return 'live';
  if (covered || live === 'done') return 'done';
  if (live === 'failed' || live === 'cancelled') return 'failed';
  return 'none';
}

/** Запуск, його проєкт, сцени й знімок для `advance`; null — запуск або проєкт видалено. */
export async function loadRun(deps: AppDeps, runId: string): Promise<LoadedRun | null> {
  const [run] = await deps.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
  if (!run) return null;
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, run.projectId));
  if (!project) return null;
  const scenes = await deps.db
    .select()
    .from(pipelineScenes)
    .where(eq(pipelineScenes.runId, run.id))
    .orderBy(asc(pipelineScenes.position));

  const statuses = await jobStatuses(deps, [run.scriptJobId, run.assembleJobId, ...scenes.map((s) => s.jobId)]);
  // id задачі запуску є, а рядка немає — вважаємо задачу невдалою (інакше умова `… is null` заблокувала б етап)
  const runJob = (id: string | null): JobStatus | null => (id ? (statuses.get(id) ?? 'failed') : null);

  const genIds = scenes.flatMap((s) => (s.generationId ? [s.generationId] : []));
  const gens = genIds.length
    ? await deps.db
        .select({ id: generations.id, status: generations.status, assetIds: generations.assetIds })
        .from(generations)
        .where(inArray(generations.id, genIds))
    : [];
  const genById = new Map(gens.map((g) => [g.id, g]));
  const genAssetIds = gens.flatMap((g) => (g.assetIds[0] ? [g.assetIds[0]] : []));
  const assetRows = genAssetIds.length
    ? await deps.db.select({ id: assets.id, status: assets.status }).from(assets).where(inArray(assets.id, genAssetIds))
    : [];
  const assetStatus = new Map(assetRows.map((a) => [a.id, a.status]));

  const sceneSnaps: SceneSnap[] = scenes.map((s) => {
    const g = s.generationId ? genById.get(s.generationId) : undefined;
    const assetId = g?.assetIds[0] ?? null;
    return {
      id: s.id,
      status: s.status,
      hasVisual: s.visualAssetId !== null,
      job: s.jobId ? (statuses.get(s.jobId) ?? null) : null,
      generation: g
        ? { status: g.status, assetId, assetStatus: assetId ? (assetStatus.get(assetId) ?? null) : null }
        : null,
    };
  });

  const segments = normalizeDoc(project.timeline).segments ?? [];
  const lines = await deps.db.select().from(voiceLines).where(eq(voiceLines.projectId, project.id));
  const translateJobs = await deps.db
    .select({ status: jobs.status, language: sql<string>`${jobs.payload}->>'language'` })
    .from(jobs)
    .where(and(eq(jobs.type, 'voice.translate'), sql`${jobs.payload}->>'projectId' = ${project.id}`))
    .orderBy(desc(jobs.createdAt));
  const langs: LangSnap[] = projectLanguages(project).map((language) => {
    const own = new Map(lines.filter((l) => l.language === language).map((l) => [l.segmentId, l]));
    const langLines = segments.map((seg) => {
      const l = own.get(seg.id);
      return l ? { status: l.status, hasText: l.text.trim() !== '' } : { status: 'empty' as const, hasText: false };
    });
    const isBase = language === project.baseLanguage;
    const latest = translateJobs.find((j) => j.language === language)?.status;
    return {
      language,
      isBase,
      translate: isBase ? 'done' : translateState(latest, segments.length > 0 && langLines.every((l) => l.hasText)),
      lines: langLines,
    };
  });

  return {
    run,
    project,
    scenes,
    snap: {
      stage: run.stage,
      status: run.status,
      stopAfterScript: run.settings.stopAfterScript,
      scriptJob: runJob(run.scriptJobId),
      assembleJob: runJob(run.assembleJobId),
      scenesWritten: scenes.length > 0,
      scenes: sceneSnaps,
      langs,
    },
  };
}

/** Знімок запуску для `advance`; null — запуск або проєкт видалено. */
export async function loadSnapshot(deps: AppDeps, runId: string): Promise<RunSnap | null> {
  return (await loadRun(deps, runId))?.snap ?? null;
}
