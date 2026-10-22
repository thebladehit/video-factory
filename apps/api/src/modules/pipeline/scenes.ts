import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '@vf/db';
import { pipelineRuns, pipelineScenes, projects, voiceLines } from '@vf/db';
import { AppError, normalizeDoc } from '@vf/shared';
import { estimateSceneSec, skeletonDoc } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { clearFailure, MAX_LINE_CHARS, setText } from '../voice/service';
import { ownRun } from './service';
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
