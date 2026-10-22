import { randomUUID } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import {
  buildOutlinePrompt,
  buildScriptPrompt,
  outlineSchema,
  SCRIPT_PROMPT_VERSION,
  scenePlan,
  scriptSchema,
  validateScript,
  type ScriptResult,
  type TextGen,
} from '@vf/ai';
import { pipelineRuns, pipelineScenes, projects, userSettings, voiceLines } from '@vf/db';
import type { JobContext, JobDef } from '@vf/jobs';
import { AppError, isAppError, type PipelineSettings, type VideoFormat } from '@vf/shared';
import { estimateSceneSec, skeletonDoc } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { finishGeneration, isCancelled, startGeneration } from '../voice/job-utils';

/** Межа сцен усього сценарію (як у перевірці відповіді) */
const MAX_SCENES = 60;
const MAX_TITLE_CHARS = 200;
/** Скільки останніх сцен передати розділу як контекст */
const CONTEXT_SCENES = 3;

type Usage = { inputTokens: number; outputTokens: number };
interface Ctx {
  gen: TextGen;
  signal: AbortSignal;
  usage: Usage;
}

/** Стиль каналу користувача (`user_settings.channel_style`). */
export async function channelStyle(deps: AppDeps, userId: string): Promise<string> {
  const [s] = await deps.db
    .select({ style: userSettings.channelStyle })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return s?.style ?? '';
}

/**
 * Помилка схеми від провайдера (AI SDK: «No object generated…») — теж «невалідна відповідь»: повторюємо з її текстом.
 * Контент-політика, ліміти, ключі — ні (інші PROVIDER_ERROR кидаються одразу).
 */
const schemaMismatch = (e: unknown) => isAppError(e) && /no object generated|did not match schema/i.test(e.message);

async function call<T>(
  c: Ctx,
  schema: Parameters<TextGen['generateObject']>[0],
  req: { system: string; prompt: string },
) {
  return (await c.gen.generateObject(schema, {
    ...req,
    signal: c.signal,
    onUsage: (u) => {
      c.usage.inputTokens += u.inputTokens;
      c.usage.outputTokens += u.outputTokens;
    },
  })) as T;
}

/** Сценарій за промптом із перевіркою; невалідна відповідь — одна повторна спроба з переліком помилок, далі помилка. */
async function validScript(
  c: Ctx,
  build: (errors?: string[]) => { system: string; prompt: string },
  plan: { scenes: number },
): Promise<ScriptResult> {
  let errors: string[] | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: ScriptResult;
    try {
      result = await call<ScriptResult>(c, scriptSchema, build(errors));
    } catch (e) {
      if (!schemaMismatch(e)) throw e;
      errors = [(e as Error).message];
      continue;
    }
    errors = validateScript(result, plan);
    if (!errors.length) return result;
  }
  throw new AppError('VALIDATION', `Модель повернула невалідний сценарій: ${errors!.slice(0, 3).join('; ')}`);
}

/** Генерація сценарію (спека 4.1): 16:9 > 40 сцен — план розділів, потім сцени кожного розділу з контекстом. */
async function generateScript(
  c: Ctx,
  s: PipelineSettings,
  format: VideoFormat,
  style: string,
  progress: JobContext['progress'],
): Promise<ScriptResult> {
  const common = { topic: s.topic, language: s.baseLanguage, channelStyle: style, style: s.style };
  const plan = scenePlan(format, s.targetSec);
  if (!plan.twoStage) {
    await progress(10, 'Пишу сценарій');
    return validScript(c, (errors) => buildScriptPrompt({ ...common, format, targetSec: s.targetSec, errors }), plan);
  }
  await progress(5, 'Складаю план розділів');
  const outline = await call<{ title: string; sections: { title: string; summary: string; sec: number }[] }>(
    c,
    outlineSchema,
    buildOutlinePrompt({ ...common, targetSec: s.targetSec }),
  );
  if (!outline.sections.length) throw new AppError('VALIDATION', 'Модель повернула порожній план розділів');
  const scenes: ScriptResult['scenes'] = [];
  for (const [i, section] of outline.sections.entries()) {
    await progress(10 + (80 * i) / outline.sections.length, `Пишу розділ ${i + 1} з ${outline.sections.length}`);
    const part = await validScript(
      c,
      (errors) =>
        buildScriptPrompt({
          ...common,
          format,
          targetSec: s.targetSec,
          section: { ...section, previous: scenes.slice(-CONTEXT_SCENES).map((x) => x.narration) },
          errors,
        }),
      scenePlan(format, section.sec),
    );
    scenes.push(...part.scenes);
  }
  // сума розділів може трохи перевищити межу — кінцівку відкидаємо, а не весь сценарій
  return { title: outline.title, scenes: scenes.slice(0, MAX_SCENES) };
}

/**
 * Сцени, рядки базової мови (`text_origin='script'`) і документ-скелет — однією транзакцією, лише якщо сцен
 * запуску ще немає (рядок запуску блокується: дві задачі сценарію не запишуть два набори). Повертає кількість сцен;
 * 0 — запуску/проєкту вже немає або задачу скасовано.
 */
async function saveScript(deps: AppDeps, runId: string, script: ScriptResult, signal: AbortSignal): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const [run] = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).for('update');
    if (!run || signal.aborted) return 0;
    const [{ n }] = (await tx.select({ n: count() }).from(pipelineScenes).where(eq(pipelineScenes.runId, runId))) as [
      { n: number },
    ];
    if (n > 0) return n;
    const [p] = await tx.select().from(projects).where(eq(projects.id, run.projectId)).for('update');
    if (!p) return 0;
    const rows = script.scenes.map((sc, position) => ({ ...sc, segmentId: randomUUID(), position }));
    await tx.insert(pipelineScenes).values(
      rows.map((r) => ({
        userId: run.userId,
        runId,
        segmentId: r.segmentId,
        position: r.position,
        visualPrompt: r.visualPrompt.trim(),
        keywords: [...new Set(r.keywords.map((k) => k.trim()).filter(Boolean))],
      })),
    );
    await tx.insert(voiceLines).values(
      rows.map((r) => ({
        userId: run.userId,
        projectId: p.id,
        segmentId: r.segmentId,
        language: p.baseLanguage,
        text: r.narration.trim(),
        textOrigin: 'script' as const,
      })),
    );
    const doc = skeletonDoc(
      p.format,
      p.fps,
      rows.map((r) => ({ segmentId: r.segmentId, estimatedSec: estimateSceneSec(r.narration.trim()) })),
    );
    const title = script.title.trim().slice(0, MAX_TITLE_CHARS);
    await tx
      .update(projects)
      .set({
        ...(title ? { title } : {}),
        timeline: doc,
        timelineVersion: p.timelineVersion + 1,
        assetIds: [],
        updatedAt: new Date(),
      })
      .where(eq(projects.id, p.id));
    return rows.length;
  });
}

/**
 * pipeline.script (спека 4.1): сценарій моделлю `settings.textModel` → сцени, рядки базової мови, скелет, назва.
 * Ідемпотентна: сцени вже є — нічого не генерує (етап доводить `advance` за подією `done`).
 * Проєкт/запуск видалено — `{ scenes: 0 }` без винятку.
 */
export function scriptJob(deps: AppDeps): JobDef<{ projectId: string }, { scenes: number }> {
  return {
    type: 'pipeline.script',
    concurrency: 2,
    async handler({ projectId }, ctx) {
      const [row] = await deps.db
        .select({ run: pipelineRuns, project: projects })
        .from(pipelineRuns)
        .innerJoin(projects, eq(projects.id, pipelineRuns.projectId))
        .where(and(eq(pipelineRuns.projectId, projectId), eq(pipelineRuns.userId, ctx.userId)));
      if (!row) return { scenes: 0 };
      const { run, project } = row;
      const [{ n }] = (await deps.db
        .select({ n: count() })
        .from(pipelineScenes)
        .where(eq(pipelineScenes.runId, run.id))) as [{ n: number }];
      if (n > 0) return { scenes: n };

      const s = run.settings;
      const entry = (await deps.ai.catalog(run.userId)).find((e) => e.ref === s.textModel && e.capability === 'text');
      const genId = await startGeneration(deps, {
        userId: run.userId,
        capability: 'text',
        ref: s.textModel,
        prompt: s.topic,
        params: {
          purpose: 'script',
          projectId,
          format: project.format,
          targetSec: s.targetSec,
          promptVersion: SCRIPT_PROMPT_VERSION,
        },
        jobId: ctx.jobId,
      });
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let script: ScriptResult;
      try {
        const gen = await deps.ai.text(run.userId, s.textModel);
        script = await generateScript(
          { gen, signal: ctx.signal, usage },
          s,
          project.format,
          await channelStyle(deps, run.userId),
          ctx.progress,
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
      await ctx.progress(95, 'Записую сцени');
      return { scenes: await saveScript(deps, run.id, script, ctx.signal) };
    },
  };
}
