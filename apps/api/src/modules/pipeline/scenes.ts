import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@vf/db';
import { assets, generations, jobs, pipelineRuns, pipelineScenes, projects, voiceLines } from '@vf/db';
import { AppError, normalizeDoc, type ModelRef } from '@vf/shared';
import { estimateSceneSec, skeletonDoc } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { generateVideo } from '../generate/service';
import { clearFailure, MAX_LINE_CHARS, setText } from '../voice/service';
import { serialized } from './run-advance';
import { advanceQuietly, ownRun } from './service';
import { applySceneVisual } from './visual-swap';
import type { RunRow, SceneRow } from './snapshot';

/** Межі сценарію (як у перевірці відповіді моделі) */
export const MAX_SCENES = 60;
const MAX_KEYWORDS = 8;
const MAX_KEYWORD_CHARS = 100;
const MAX_PROMPT_CHARS = 4000;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const sceneNotFound = () => new AppError('NOT_FOUND', 'Сцену не знайдено');
const notInReview = () =>
  new AppError('VALIDATION', 'Додавати, видаляти й переставляти сцени можна лише на перевірці сценарію');

/** Сцена власного запуску; чужа/неіснуюча → NOT_FOUND. */
async function ownScene(deps: AppDeps, userId: string, sceneId: string): Promise<{ scene: SceneRow; run: RunRow }> {
  if (!isUuid(sceneId)) throw sceneNotFound();
  const [row] = await deps.db
    .select({ scene: pipelineScenes, run: pipelineRuns })
    .from(pipelineScenes)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, pipelineScenes.runId))
    .where(and(eq(pipelineScenes.id, sceneId), eq(pipelineScenes.userId, userId), eq(pipelineRuns.userId, userId)));
  if (!row) throw sceneNotFound();
  return row;
}

function checkNarration(text: string): string {
  if (!text.trim()) throw new AppError('VALIDATION', 'Текст сцени не може бути порожнім');
  if (text.length > MAX_LINE_CHARS)
    throw new AppError('VALIDATION', `Текст довший за ${MAX_LINE_CHARS} символів — розділіть сцену`);
  return text;
}

function checkKeywords(keywords: string[]): string[] {
  const list = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))];
  if (list.length < 1 || list.length > MAX_KEYWORDS || list.some((k) => k.length > MAX_KEYWORD_CHARS))
    throw new AppError('VALIDATION', `Ключових слів має бути від 1 до ${MAX_KEYWORDS}`);
  return list;
}

/** Ключові слова нової сцени з тексту: перші значущі (≥ 4 літери) слова без повторів, ≤ 8; інакше — перше слово. */
export function keywordsFrom(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).map((w) =>
    w.slice(0, MAX_KEYWORD_CHARS),
  );
  const significant = [...new Set(words.filter((w) => [...w].length >= 4))].slice(0, MAX_KEYWORDS);
  return significant.length ? significant : words.slice(0, 1);
}

/** Блокує запуск (правки сцен ідуть по черзі) і перевіряє, що він на перевірці сценарію. */
async function lockReview(tx: Tx, runId: string): Promise<RunRow> {
  const [run] = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).for('update');
  if (!run || run.stage !== 'review') throw notInReview();
  return run;
}

const scenesOf = (tx: Tx, runId: string) =>
  tx.select().from(pipelineScenes).where(eq(pipelineScenes.runId, runId)).orderBy(asc(pipelineScenes.position));

/** position = індекс у `ordered` (лише змінені рядки). */
async function renumber(tx: Tx, ordered: SceneRow[]): Promise<void> {
  for (const [i, s] of ordered.entries())
    if (s.position !== i)
      await tx.update(pipelineScenes).set({ position: i, updatedAt: new Date() }).where(eq(pipelineScenes.id, s.id));
}

/**
 * Документ-скелет за сценами в порядку position: сегменти впритул від 0 з оціненою тривалістю тексту базової мови.
 * Версія документа +1 (редактор побачить зміну як звичайне збереження).
 */
export async function rebuildSkeleton(tx: Tx, run: RunRow): Promise<void> {
  const [p] = await tx.select().from(projects).where(eq(projects.id, run.projectId)).for('update');
  if (!p) return;
  const scenes = await scenesOf(tx, run.id);
  const lines = await tx
    .select({ segmentId: voiceLines.segmentId, text: voiceLines.text })
    .from(voiceLines)
    .where(and(eq(voiceLines.projectId, p.id), eq(voiceLines.language, p.baseLanguage)));
  const text = new Map(lines.map((l) => [l.segmentId, l.text]));
  const doc = skeletonDoc(
    p.format,
    p.fps,
    scenes.map((s) => ({ segmentId: s.segmentId, estimatedSec: estimateSceneSec(text.get(s.segmentId) ?? '') })),
  );
  await tx
    .update(projects)
    .set({ timeline: doc, timelineVersion: p.timelineVersion + 1, assetIds: [], updatedAt: new Date() })
    .where(eq(projects.id, p.id));
}

/** Правка сцени будь-коли, крім етапу script; `narration` → рядок базової мови (`text_origin='script'`). */
export async function updateScene(
  deps: AppDeps,
  userId: string,
  input: { sceneId: string; narration?: string; visualPrompt?: string; keywords?: string[] },
): Promise<void> {
  const { scene, run } = await ownScene(deps, userId, input.sceneId);
  if (run.stage === 'script') throw new AppError('VALIDATION', 'Сценарій ще створюється — зачекайте');
  const patch: Partial<typeof pipelineScenes.$inferInsert> = {};
  if (input.visualPrompt !== undefined) {
    const prompt = input.visualPrompt.trim();
    if (!prompt || prompt.length > MAX_PROMPT_CHARS)
      throw new AppError('VALIDATION', `Опис візуалу має бути від 1 до ${MAX_PROMPT_CHARS} символів`);
    patch.visualPrompt = prompt;
  }
  if (input.keywords !== undefined) patch.keywords = checkKeywords(input.keywords);
  // спершу всі перевірки (включно з тими, що робить setText), потім запис: помилка не лишає половину змін
  let baseLanguage: string | null = null;
  if (input.narration !== undefined) {
    checkNarration(input.narration);
    const [p] = await deps.db.select().from(projects).where(eq(projects.id, run.projectId));
    if (!p) throw sceneNotFound();
    if (!(normalizeDoc(p.timeline).segments ?? []).some((sg) => sg.id === scene.segmentId))
      throw new AppError('VALIDATION', 'Сцени немає в таймлайні — змініть текст у студії озвучки');
    baseLanguage = p.baseLanguage;
  }
  if (baseLanguage !== null)
    await setText(deps, userId, {
      projectId: run.projectId,
      segmentId: scene.segmentId,
      language: baseLanguage,
      text: input.narration!,
      origin: 'script',
    });
  if (Object.keys(patch).length)
    await deps.db
      .update(pipelineScenes)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(pipelineScenes.id, scene.id));
  if (input.narration === undefined) return;
  // на перевірці тривалості скелета йдуть за текстом; пізніше документ уже не скелет (або ось-ось зберуть)
  if (run.stage === 'review')
    await deps.db.transaction(async (tx) => {
      const locked = await tx.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id)).for('update');
      if (locked[0]?.stage === 'review') await rebuildSkeleton(tx, locked[0]);
    });
}

/** Нова сцена після `after` (без нього — у кінці) з текстом базової мови. */
export async function addScene(
  deps: AppDeps,
  userId: string,
  input: { projectId: string; after?: string; narration: string },
): Promise<{ sceneId: string }> {
  const run = await ownRun(deps, userId, input.projectId);
  const text = checkNarration(input.narration);
  return deps.db.transaction(async (tx) => {
    const locked = await lockReview(tx, run.id);
    const scenes = await scenesOf(tx, run.id);
    if (scenes.length >= MAX_SCENES) throw new AppError('VALIDATION', `Не більше ${MAX_SCENES} сцен`);
    let at = scenes.length;
    if (input.after !== undefined) {
      const i = scenes.findIndex((s) => s.id === input.after);
      if (i < 0) throw sceneNotFound();
      at = i + 1;
    }
    const [p] = await tx
      .select({ baseLanguage: projects.baseLanguage })
      .from(projects)
      .where(eq(projects.id, run.projectId));
    const segmentId = randomUUID();
    const [row] = await tx
      .insert(pipelineScenes)
      .values({
        userId,
        runId: run.id,
        segmentId,
        position: at,
        visualPrompt: text.trim().slice(0, MAX_PROMPT_CHARS),
        keywords: keywordsFrom(text),
      })
      .returning();
    await renumber(tx, [...scenes.slice(0, at), row!, ...scenes.slice(at)]);
    const patch = { text, textOrigin: 'script' as const, sourceHash: null, updatedAt: new Date() };
    await tx
      .insert(voiceLines)
      .values({ userId, projectId: run.projectId, segmentId, language: p!.baseLanguage, ...patch })
      .onConflictDoUpdate({
        target: [voiceLines.projectId, voiceLines.segmentId, voiceLines.language],
        set: { ...patch, ...clearFailure },
      });
    await rebuildSkeleton(tx, locked);
    return { sceneId: row!.id };
  });
}

/** Видалення сцени на перевірці; рядки озвучки її сегмента лишаються «сиротами» (як у студії). */
export async function deleteScene(deps: AppDeps, userId: string, sceneId: string): Promise<void> {
  const { scene, run } = await ownScene(deps, userId, sceneId);
  await deps.db.transaction(async (tx) => {
    const locked = await lockReview(tx, run.id);
    const scenes = await scenesOf(tx, run.id);
    if (!scenes.some((s) => s.id === scene.id)) throw sceneNotFound();
    if (scenes.length <= 1) throw new AppError('VALIDATION', 'Має лишитися хоча б одна сцена');
    await tx.delete(pipelineScenes).where(eq(pipelineScenes.id, scene.id));
    await renumber(
      tx,
      scenes.filter((s) => s.id !== scene.id),
    );
    await rebuildSkeleton(tx, locked);
  });
}

/** Переставляє сцену на `position` (обмежується межами списку). */
export async function moveScene(
  deps: AppDeps,
  userId: string,
  input: { sceneId: string; position: number },
): Promise<void> {
  const { scene, run } = await ownScene(deps, userId, input.sceneId);
  await deps.db.transaction(async (tx) => {
    const locked = await lockReview(tx, run.id);
    const scenes = await scenesOf(tx, run.id);
    const current = scenes.find((s) => s.id === scene.id);
    if (!current) throw sceneNotFound();
    const rest = scenes.filter((s) => s.id !== scene.id);
    const to = Math.min(Math.max(0, Math.trunc(input.position)), rest.length);
    await renumber(tx, [...rest.slice(0, to), current, ...rest.slice(to)]);
    await rebuildSkeleton(tx, locked);
  });
}

/**
 * «↻ текст» сцени: задача `pipeline.scene` (будь-коли, крім етапу script). Жива задача цієї сцени вже є —
 * повертається вона (повторне натискання не ставить другу).
 */
export async function regenerateSceneText(deps: AppDeps, userId: string, sceneId: string): Promise<{ jobId: string }> {
  const { scene, run } = await ownScene(deps, userId, sceneId);
  if (run.stage === 'script') throw new AppError('VALIDATION', 'Сценарій ще створюється — зачекайте');
  const [live] = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, 'pipeline.scene'),
        inArray(jobs.status, ['queued', 'running']),
        sql`${jobs.payload}->>'sceneId' = ${scene.id}`,
      ),
    )
    .limit(1);
  if (live) return { jobId: live.id };
  return { jobId: await deps.jobs.queue.enqueue('pipeline.scene', { sceneId: scene.id }, { userId }) };
}

const liveStatuses = ['queued', 'running'] as ('queued' | 'running')[];

/**
 * Етапи, на яких можна змінювати візуал сцени. Генерація (знову / відео) — лише після перевірки сценарію, бо її файл
 * прив'язує `advance`, а на перевірці він нічого не робить; вибір файлу — й на перевірці. Під час збірки — ні:
 * збірка вже читає сцени. Запуск, зупинений помилкою чи скасуванням, — лише після «Повторити».
 */
function checkVisualStage(run: RunRow, manual: boolean): void {
  if (run.status === 'cancelled' || run.status === 'failed')
    throw new AppError('VALIDATION', 'Запуск зупинено — натисніть «Повторити»');
  if (run.stage === 'script') throw new AppError('VALIDATION', 'Сценарій ще створюється — зачекайте');
  if (run.stage === 'review' && !manual)
    throw new AppError('VALIDATION', 'Візуал генерується після перевірки сценарію — натисніть «Продовжити»');
  if (run.stage === 'assemble') throw new AppError('VALIDATION', 'Триває збірка чернетки — зачекайте');
}

/** Скасовує живу задачу візуалу сцени й живу генерацію її фото/відео (помилки — лише в журнал). */
async function stopSceneWork(deps: AppDeps, scene: SceneRow): Promise<void> {
  const ids: string[] = [];
  if (scene.jobId && liveStatuses.includes(scene.status as 'queued')) ids.push(scene.jobId);
  if (scene.generationId) {
    const [g] = await deps.db
      .select({ status: generations.status, jobId: generations.jobId })
      .from(generations)
      .where(eq(generations.id, scene.generationId));
    if (g?.jobId && liveStatuses.includes(g.status as 'queued')) ids.push(g.jobId);
  }
  for (const id of ids) {
    try {
      await deps.jobs.queue.cancel(id);
    } catch (e) {
      deps.log.error({ err: e, jobId: id }, 'pipeline: не вдалося скасувати задачу візуалу сцени');
    }
  }
}

/** Актуальний стан запуску всередині черги викликів (перевірка до черги могла застаріти). */
async function freshVisualStage(deps: AppDeps, runId: string, manual: boolean): Promise<RunRow> {
  const [run] = await deps.db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
  if (!run) throw sceneNotFound();
  checkVisualStage(run, manual);
  return run;
}

const freshScene = async (deps: AppDeps, sceneId: string): Promise<SceneRow> => {
  const [s] = await deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, sceneId));
  if (!s) throw sceneNotFound();
  return s;
};

const clearedVisual = { visualAssetId: null, visualSource: null, generationId: null, jobId: null, error: null };

/**
 * «Згенерувати знову» (спека 4.2): поточна робота сцени скасовується, візуал і генерація очищуються, ставиться
 * `pipeline.visual { sceneId, regenerate: true }` (без пошуку в бібліотеці). Проміжний стан «queued без id задачі»
 * не бачить жоден `advance` — усе в черзі викликів запуску.
 */
export async function regenerateSceneVisual(
  deps: AppDeps,
  userId: string,
  sceneId: string,
): Promise<{ jobId: string }> {
  const { run } = await ownScene(deps, userId, sceneId);
  checkVisualStage(run, false);
  const jobId = await serialized(run.id, async () => {
    await freshVisualStage(deps, run.id, false);
    const cur = await freshScene(deps, sceneId);
    await stopSceneWork(deps, cur);
    await deps.db
      .update(pipelineScenes)
      .set({ ...clearedVisual, status: 'queued', updatedAt: new Date() })
      .where(eq(pipelineScenes.id, sceneId));
    const id = await deps.jobs.queue.enqueue('pipeline.visual', { sceneId, regenerate: true }, { userId });
    await deps.db
      .update(pipelineScenes)
      .set({ jobId: id })
      .where(
        and(eq(pipelineScenes.id, sceneId), inArray(pipelineScenes.status, liveStatuses), isNull(pipelineScenes.jobId)),
      );
    return id;
  });
  return { jobId };
}

/**
 * «Згенерувати відео»: наявний `generateVideo` (модель і тривалість перевіряє він — до будь-яких змін сцени),
 * промпт — `visual_prompt`, aspect — формат проєкту; сцена `running` з новою генерацією, файл прив'язує `advance`.
 */
export async function generateSceneVideo(
  deps: AppDeps,
  userId: string,
  i: { sceneId: string; model: ModelRef; durationSec?: number },
): Promise<{ generationId: string }> {
  const { run } = await ownScene(deps, userId, i.sceneId);
  checkVisualStage(run, false);
  const [project] = await deps.db
    .select({ format: projects.format })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  if (!project) throw sceneNotFound();
  const generationId = await serialized(run.id, async () => {
    await freshVisualStage(deps, run.id, false);
    const cur = await freshScene(deps, i.sceneId);
    const { generationId } = await generateVideo(deps, userId, {
      model: i.model,
      prompt: cur.visualPrompt,
      aspect: project.format,
      durationSec: i.durationSec,
    });
    await stopSceneWork(deps, cur);
    await deps.db
      .update(pipelineScenes)
      .set({ ...clearedVisual, generationId, status: 'running', updatedAt: new Date() })
      .where(eq(pipelineScenes.id, i.sceneId));
    return generationId;
  });
  // генерація могла завершитись раніше, ніж сцена її отримала
  await advanceQuietly(deps, run.id);
  return { generationId };
}

/**
 * «Вибрати з бібліотеки» / підказка: власний готовий фото- чи відеофайл → `visual_source='manual'`, сцена `ready`
 * (поточна робота сцени скасовується). Чужий/неіснуючий файл → NOT_FOUND; аудіо чи не готовий → VALIDATION.
 * Можна й на перевірці сценарію (тоді «Продовжити» цю сцену вже не генерує); після `done` кліп сегмента
 * замінюється точково.
 */
export async function setSceneVisual(
  deps: AppDeps,
  userId: string,
  i: { sceneId: string; assetId: string },
): Promise<void> {
  const { run } = await ownScene(deps, userId, i.sceneId);
  const notFound = () => new AppError('NOT_FOUND', 'Файл не знайдено');
  if (!isUuid(i.assetId)) throw notFound();
  const [a] = await deps.db
    .select({ kind: assets.kind, status: assets.status })
    .from(assets)
    .where(and(eq(assets.id, i.assetId), eq(assets.userId, userId)));
  if (!a) throw notFound();
  if ((a.kind !== 'image' && a.kind !== 'video') || a.status !== 'ready')
    throw new AppError('VALIDATION', 'Візуал сцени — це готове фото або відео з бібліотеки');
  checkVisualStage(run, true);
  await serialized(run.id, async () => {
    const fresh = await freshVisualStage(deps, run.id, true);
    const cur = await freshScene(deps, i.sceneId);
    await stopSceneWork(deps, cur);
    // після збірки — точкова заміна кліпу сегмента (немає сегмента — документ не змінюється), разом із `ready`
    await deps.db.transaction(async (tx) => {
      await tx
        .update(pipelineScenes)
        .set({
          ...clearedVisual,
          visualAssetId: i.assetId,
          visualSource: 'manual',
          status: 'ready',
          updatedAt: new Date(),
        })
        .where(eq(pipelineScenes.id, i.sceneId));
      if (fresh.stage === 'done') await applySceneVisual(deps, i.sceneId, tx);
    });
  });
  await advanceQuietly(deps, run.id);
}
