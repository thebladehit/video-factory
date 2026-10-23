import { and, asc, eq, inArray } from 'drizzle-orm';
import { PRESETS } from '@vf/captions';
import { assets, pipelineRuns, pipelineScenes, projects, voiceLines } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { type VideoFormat } from '@vf/shared';
import { assembleTimeline, estimateSceneSec, syncVoiceTrack, type AssembleScene, type SceneVisual } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { timelineAssetIds } from '../projects/service';
import { parseVoice, withDelivery } from '../voice/service';
import { lineState } from '../voice/stale';
import { baseTakesOf } from '../voice/takes';
import { ensureBlankAsset } from './blank';
import { sceneVisualOf } from './visual-swap';

/** Пресет субтитрів чернетки за форматом */
export const CAPTION_PRESET: Record<VideoFormat, string> = { '9:16': 'preset:shorts', '16:9': 'preset:classic' };

/**
 * pipeline.assemble (спека 4.3): сцени за `position` → тривалість з готової й не застарілої озвучки базової мови
 * (`duration_ms`), інакше оцінка за текстом; візуал — готовий asset сцени, інакше чорна заглушка; музика —
 * готовий аудіофайл із відомою тривалістю (без неї — без музики) → `assembleTimeline`. Запис — під блокуванням
 * запуску й проєкту: версія +1, `asset_ids`, `assembled_version`, `projects.voice` (субтитри всіх мов увімкнено з
 * пресетом формату, `original.mode='replace'`). Пише лише поточна задача збірки запуску (`assemble_job_id`) і лише
 * без скасування (`ctx.signal`): «Повторити» може поставити нову збірку, поки стара ще зупиняється.
 * Етап → done робить `advance` за кінцевою подією цієї задачі. Запуску/проєкту немає — no-op без винятку.
 */
export function assembleJob(deps: AppDeps): JobDef<{ projectId: string }, { version: number }> {
  return {
    type: 'pipeline.assemble',
    concurrency: 2,
    async handler({ projectId }, ctx) {
      const none = { version: 0 };
      if (!isUuid(projectId)) return none;
      const [row] = await deps.db
        .select({ run: pipelineRuns, project: projects })
        .from(pipelineRuns)
        .innerJoin(projects, eq(projects.id, pipelineRuns.projectId))
        .where(and(eq(pipelineRuns.projectId, projectId), eq(pipelineRuns.userId, ctx.userId)));
      if (!row || ctx.signal.aborted) return none;
      const { run, project } = row;
      await ctx.progress(10, 'Збираю чернетку');

      const scenes = await deps.db
        .select()
        .from(pipelineScenes)
        .where(eq(pipelineScenes.runId, run.id))
        .orderBy(asc(pipelineScenes.position));
      const voice = parseVoice(project.voice);
      // один голос і для тривалостей сцен, і для дублів доріжки (проєкт ще може не мати голосу — його пише ця збірка)
      const baseVoice = withDelivery(
        voice.languages[project.baseLanguage]?.voice ?? run.settings.voices[project.baseLanguage],
        project.baseLanguage,
      );
      const lines = await deps.db
        .select()
        .from(voiceLines)
        .where(and(eq(voiceLines.projectId, project.id), eq(voiceLines.language, project.baseLanguage)));
      const lineOf = new Map(lines.map((l) => [l.segmentId, l]));

      const visualIds = scenes.flatMap((s) => (s.visualAssetId ? [s.visualAssetId] : []));
      const files = visualIds.length
        ? await deps.db
            .select()
            .from(assets)
            .where(and(eq(assets.userId, run.userId), inArray(assets.id, visualIds)))
        : [];
      const fileOf = new Map(files.map((a) => [a.id, a]));
      let blank: SceneVisual | null = null;

      const input: AssembleScene[] = [];
      for (const s of scenes) {
        const line = lineOf.get(s.segmentId);
        const voiced =
          line && line.durationMs != null && lineState(line, undefined, baseVoice) === 'ready'
            ? line.durationMs / 1000
            : null;
        let visual = s.visualAssetId ? sceneVisualOf(fileOf.get(s.visualAssetId)) : null;
        visual ??= blank ??= await ensureBlankAsset(deps, run.userId, project.format);
        input.push({
          segmentId: s.segmentId,
          estimatedSec: estimateSceneSec(line?.text ?? ''),
          baseVoiceSec: voiced,
          visual,
        });
      }

      let music: { assetId: string; durationSec: number } | null = null;
      if (run.settings.musicAssetId) {
        const [m] = await deps.db
          .select()
          .from(assets)
          .where(and(eq(assets.id, run.settings.musicAssetId), eq(assets.userId, run.userId)));
        if (m && m.kind === 'audio' && m.status === 'ready' && m.durationMs != null)
          music = { assetId: m.id, durationSec: m.durationMs / 1000 };
      }

      const assembled = assembleTimeline({ format: project.format, fps: project.fps, scenes: input, music });
      // доріжка озвучки базової мови: по кліпу на озвучену сцену (дублі беруться за сегментами нового документа)
      const takes = await baseTakesOf(deps, run.userId, { ...project, timeline: assembled }, baseVoice);
      const doc = syncVoiceTrack(assembled, { language: project.baseLanguage, takes }).doc;
      await ctx.progress(80, 'Зберігаю чернетку');
      if (ctx.signal.aborted) return none;

      const version = await deps.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id)).for('update');
        // інша (новіша) збірка або скасування — цей результат уже нікому не потрібен
        if (!locked || locked.assembleJobId !== ctx.jobId || ctx.signal.aborted) return null;
        if (locked.stage !== 'assemble' && locked.stage !== 'done') return null;
        const [p] = await tx.select().from(projects).where(eq(projects.id, project.id)).for('update');
        if (!p) return null;
        const v = parseVoice(p.voice);
        const styleId = PRESETS.find((x) => x.id === CAPTION_PRESET[p.format])?.id ?? PRESETS[0]!.id;
        for (const language of locked.settings.languages)
          v.languages[language] = {
            // голос, змінений у студії після старту, лишається (інакше всі рядки мови стали б застарілими)
            voice: v.languages[language]?.voice ?? locked.settings.voices[language],
            captions: { enabled: true, styleId },
          };
        v.original = { ...v.original, mode: 'replace' };
        const next = p.timelineVersion + 1;
        await tx
          .update(projects)
          .set({
            timeline: doc,
            timelineVersion: next,
            assetIds: timelineAssetIds(doc),
            voice: v,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, p.id));
        await tx
          .update(pipelineRuns)
          .set({ assembledVersion: next, updatedAt: new Date() })
          .where(eq(pipelineRuns.id, run.id));
        return next;
      });
      if (version === null) return none;
      await ctx.progress(100, 'Чернетку зібрано');
      return { version };
    },
  };
}
