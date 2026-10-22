import { and, asc, eq } from 'drizzle-orm';
import { buildScenePrompt, sceneSchema, SCRIPT_PROMPT_VERSION, type SceneResult } from '@vf/ai';
import { pipelineRuns, pipelineScenes, projects, voiceLines } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { AppError } from '@vf/shared';
import type { AppDeps } from '../../app';
import { finishGeneration, isCancelled, startGeneration } from '../voice/job-utils';
import { clearFailure, MAX_LINE_CHARS } from '../voice/service';
import { rebuildSkeleton } from './scenes';
import { channelStyle } from './script-job';

const MAX_KEYWORDS = 8;

function checkScene(r: SceneResult): SceneResult {
  const narration = r.narration.trim();
  const visualPrompt = r.visualPrompt.trim();
  const keywords = [...new Set(r.keywords.map((k) => k.trim()).filter(Boolean))];
  if (!narration || narration.length > MAX_LINE_CHARS || !visualPrompt || !keywords.length)
    throw new AppError('VALIDATION', 'Модель повернула невалідну сцену');
  return { narration, visualPrompt, keywords: keywords.slice(0, MAX_KEYWORDS) };
}

/**
 * pipeline.scene (спека 4.1): новий текст однієї сцени з контекстом (тема, попередня й наступна сцени) →
 * `visual_prompt`, `keywords` і рядок базової мови (`text_origin='script'`). Озвучка стає «застарілою» через
 * `voiced_hash`, переклади — через `source_hash`; нічого не перегенеровується. Стан візуалу сцени (`status`,
 * `job_id`) належить `pipeline.visual` і тут не змінюється; живу задачу сцени знаходять за payload.
 * Сцени/запуску/проєкту немає — `{ ok: false }` без винятку.
 */
export function sceneJob(deps: AppDeps): JobDef<{ sceneId: string }, { ok: boolean }> {
  return {
    type: 'pipeline.scene',
    concurrency: 2,
    async handler({ sceneId }, ctx) {
      const [row] = await deps.db
        .select({ scene: pipelineScenes, run: pipelineRuns, project: projects })
        .from(pipelineScenes)
        .innerJoin(pipelineRuns, eq(pipelineRuns.id, pipelineScenes.runId))
        .innerJoin(projects, eq(projects.id, pipelineRuns.projectId))
        .where(and(eq(pipelineScenes.id, sceneId), eq(pipelineScenes.userId, ctx.userId)));
      if (!row) return { ok: false };
      const { scene, run, project } = row;
      const s = run.settings;

      const scenes = await deps.db
        .select({ id: pipelineScenes.id, segmentId: pipelineScenes.segmentId })
        .from(pipelineScenes)
        .where(eq(pipelineScenes.runId, run.id))
        .orderBy(asc(pipelineScenes.position));
      const lines = await deps.db
        .select({ segmentId: voiceLines.segmentId, text: voiceLines.text })
        .from(voiceLines)
        .where(and(eq(voiceLines.projectId, project.id), eq(voiceLines.language, project.baseLanguage)));
      const text = new Map(lines.map((l) => [l.segmentId, l.text]));
      const idx = scenes.findIndex((x) => x.id === scene.id);
      const neighbour = (i: number) => (scenes[i] ? text.get(scenes[i].segmentId) || undefined : undefined);
      const { system, prompt } = buildScenePrompt({
        topic: s.topic,
        language: project.baseLanguage,
        channelStyle: await channelStyle(deps, run.userId),
        style: s.style,
        format: project.format,
        previous: neighbour(idx - 1),
        next: neighbour(idx + 1),
        current: text.get(scene.segmentId) || scene.visualPrompt,
      });

      const entry = (await deps.ai.catalog(run.userId)).find((e) => e.ref === s.textModel && e.capability === 'text');
      const genId = await startGeneration(deps, {
        userId: run.userId,
        capability: 'text',
        ref: s.textModel,
        prompt,
        params: { purpose: 'scene', sceneId, promptVersion: SCRIPT_PROMPT_VERSION },
        jobId: ctx.jobId,
      });
      const usage = { inputTokens: 0, outputTokens: 0 };
      let result: SceneResult;
      try {
        const gen = await deps.ai.text(run.userId, s.textModel);
        await ctx.progress(10, 'Переписую сцену');
        result = checkScene(
          await gen.generateObject(sceneSchema, {
            system,
            prompt,
            signal: ctx.signal,
            onUsage: (u) => {
              usage.inputTokens += u.inputTokens;
              usage.outputTokens += u.outputTokens;
            },
          }),
        );
        await finishGeneration(deps, genId, { status: 'done', entry, usage });
      } catch (e) {
        await finishGeneration(
          deps,
          genId,
          isCancelled(e, ctx.signal) ? { status: 'cancelled' } : { status: 'failed', error: (e as Error).message },
        );
        throw e;
      }
      if (ctx.signal.aborted) return { ok: false };

      const ok = await deps.db.transaction(async (tx) => {
        // рядок запуску блокується, як у правках сцен на перевірці (скелет перераховується узгоджено)
        const [locked] = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id)).for('update');
        const [still] = await tx
          .select({ id: pipelineScenes.id })
          .from(pipelineScenes)
          .where(eq(pipelineScenes.id, sceneId));
        if (!locked || !still) return false;
        const patch = {
          text: result.narration,
          textOrigin: 'script' as const,
          sourceHash: null,
          updatedAt: new Date(),
        };
        await tx
          .insert(voiceLines)
          .values({
            userId: run.userId,
            projectId: project.id,
            segmentId: scene.segmentId,
            language: project.baseLanguage,
            ...patch,
          })
          .onConflictDoUpdate({
            target: [voiceLines.projectId, voiceLines.segmentId, voiceLines.language],
            set: { ...patch, ...clearFailure },
          });
        await tx
          .update(pipelineScenes)
          .set({ visualPrompt: result.visualPrompt, keywords: result.keywords, updatedAt: new Date() })
          .where(eq(pipelineScenes.id, sceneId));
        // на перевірці тривалості скелета йдуть за текстом (як `updateScene`)
        if (locked.stage === 'review') await rebuildSkeleton(tx, locked);
        return true;
      });
      if (ok) await ctx.progress(100, 'Готово');
      return { ok };
    },
  };
}
