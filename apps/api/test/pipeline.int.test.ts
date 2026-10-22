import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAiRegistry,
  createEnvCredentialStore,
  outlineSchema,
  scenePlan,
  scriptSchema,
  type AiRegistry,
  type OutlineResult,
  type ScriptResult,
} from '@vf/ai';
import { assets, createDb, generations, jobs, pipelineRuns, pipelineScenes, projects, users, voiceLines } from '@vf/db';
import { RESTART_ERROR } from '@vf/jobs';
import {
  AppError,
  LOCAL_USER_ID,
  normalizeDoc,
  type JobEvent,
  type ModelRef,
  type PipelineSettings,
  type VoiceChoice,
} from '@vf/shared';
import { estimateSceneSec, skeletonDoc } from '@vf/timeline';
import { appRouter, createApp } from '../src/index';
import { LIBRARY_MATCH_MIN, matchAssets } from '../src/modules/assets/match';
import { visualJob } from '../src/modules/pipeline/visual-job';
import { executeAction, runAdvance } from '../src/modules/pipeline/run-advance';
import { keywordsFrom } from '../src/modules/pipeline/scenes';
import { handlePipelineEvent, pipelineEvents } from '../src/modules/pipeline/events';
import { loadSnapshot } from '../src/modules/pipeline/snapshot';
import { getVoice } from '../src/modules/voice/service';
import { voicedHash } from '../src/modules/voice/stale';
import { tools } from './assets-helpers';
import { testConfig } from './helpers';

const VOICE: VoiceChoice = { model: 'fake/tts' as ModelRef, voiceId: 'fake-voice' };
const fakeAi = () => createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }), media: tools });

const opened: { close(): Promise<void> }[] = [];
/** Окремі користувачі тестів візуалу (власна бібліотека); видаляються каскадом разом з усім своїм */
const freshUsers: string[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()));
  // тестова БД спільна: незавершені запуски підхопило б відновлення на старті API в інших тестах
  const probe = createDb(process.env.TEST_DATABASE_URL!);
  await probe.db.delete(projects).where(sql`${projects.id} in (select project_id from pipeline_runs)`);
  const users_ = freshUsers.splice(0);
  if (users_.length) await probe.db.delete(users).where(inArray(users.id, users_));
  await probe.close();
});

/**
 * Застосунок без запуску воркерів: поставлені задачі лишаються `queued` (обробники pipeline.* — у T7–T9,
 * тут — заглушки, бо черга приймає лише зареєстровані типи).
 */
const PIPELINE_TYPES = ['pipeline.script', 'pipeline.scene', 'pipeline.visual', 'pipeline.assemble'] as const;

async function pipelineApp(stubs: readonly (typeof PIPELINE_TYPES)[number][] = PIPELINE_TYPES) {
  const app = await createApp(testConfig(), { ai: fakeAi() });
  opened.push(app);
  for (const type of stubs) app.deps.jobs.runtime.register({ type, concurrency: 1, handler: async () => undefined });
  const caller = appRouter.createCaller({ userId: LOCAL_USER_ID, deps: app.deps });
  return { ...app, caller };
}
type App = Awaited<ReturnType<typeof pipelineApp>>;

/** Постановка задачі цього типу падає (як для незареєстрованого типу). */
function failEnqueue(s: App, failing: string) {
  const queue = s.deps.jobs.queue;
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = async (type, payload, opts) => {
    if (type === failing) throw new AppError('UNKNOWN_JOB_TYPE', `Невідомий тип задачі: ${type}`);
    return enqueue(type, payload, opts);
  };
}

const settings = (over: Partial<PipelineSettings> = {}): PipelineSettings => ({
  topic: `Як працюють чорні діри ${randomUUID()}`,
  format: '9:16',
  targetSec: 45,
  style: '',
  baseLanguage: 'uk',
  languages: ['uk', 'en'],
  textModel: 'fake/text' as ModelRef,
  imageModel: 'fake/image' as ModelRef,
  voices: { uk: VOICE, en: VOICE },
  musicAssetId: null,
  stopAfterScript: true,
  ...over,
});

const runOf = async (s: App, projectId: string) =>
  (await s.deps.db.select().from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId)))[0]!;
const scenesOf = (s: App, runId: string) =>
  s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.runId, runId)).orderBy(asc(pipelineScenes.position));
const jobsOf = (s: App, type: string) =>
  s.deps.db
    .select()
    .from(jobs)
    .where(eq(jobs.type, type))
    .then((rows) => rows);
const projectJobs = (s: App, type: string, projectId: string) =>
  s.deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, type), sql`${jobs.payload}->>'projectId' = ${projectId}`));

/** Фікстура сценарію (як записала б задача pipeline.script): сцени, рядки базової мови, документ-скелет. */
async function writeScript(s: App, projectId: string, narrations: string[]) {
  const run = await runOf(s, projectId);
  const scenes = narrations.map((n, i) => ({ segmentId: `seg-${i}`, narration: n }));
  await s.deps.db.insert(pipelineScenes).values(
    scenes.map((sc, i) => ({
      userId: LOCAL_USER_ID,
      runId: run.id,
      segmentId: sc.segmentId,
      position: i,
      visualPrompt: `prompt ${i}`,
      keywords: ['море'],
    })),
  );
  await s.deps.db.insert(voiceLines).values(
    scenes.map((sc) => ({
      userId: LOCAL_USER_ID,
      projectId,
      segmentId: sc.segmentId,
      language: 'uk',
      text: sc.narration,
      textOrigin: 'script' as const,
    })),
  );
  const doc = skeletonDoc(
    '9:16',
    30,
    scenes.map((sc) => ({ segmentId: sc.segmentId, estimatedSec: estimateSceneSec(sc.narration) })),
  );
  await s.deps.db.update(projects).set({ timeline: doc }).where(eq(projects.id, projectId));
  if (run.scriptJobId) await s.deps.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, run.scriptJobId));
  return run;
}

/** Запуск на перевірці з трьома сценами. */
async function reviewRun(s: App, narrations = ['Перша сцена.', 'Друга, трохи довша сцена.', 'Третя.']) {
  const { projectId } = await s.caller.pipeline.start(settings());
  const run = await writeScript(s, projectId, narrations);
  await s.deps.db
    .update(pipelineRuns)
    .set({ stage: 'review', status: 'awaiting_review' })
    .where(eq(pipelineRuns.id, run.id));
  return { projectId, runId: run.id };
}

/** Сегменти документа відповідають сценам за position і їхнім оціненим тривалостям. */
async function expectSkeleton(s: App, projectId: string, runId: string) {
  const [p] = await s.deps.db.select().from(projects).where(eq(projects.id, projectId));
  const scenes = await scenesOf(s, runId);
  const lines = await s.deps.db
    .select()
    .from(voiceLines)
    .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.language, 'uk')));
  const text = new Map(lines.map((l) => [l.segmentId, l.text]));
  const expected = skeletonDoc(
    '9:16',
    30,
    scenes.map((sc) => ({ segmentId: sc.segmentId, estimatedSec: estimateSceneSec(text.get(sc.segmentId) ?? '') })),
  );
  expect(scenes.map((sc) => sc.position)).toEqual(scenes.map((_, i) => i));
  expect(normalizeDoc(p!.timeline).segments).toEqual(expected.segments);
}

async function insertAsset(s: App, patch: Partial<typeof assets.$inferInsert> = {}) {
  const id = randomUUID();
  await s.deps.db.insert(assets).values({
    id,
    userId: LOCAL_USER_ID,
    kind: 'audio',
    source: 'uploaded',
    status: 'ready',
    storageKey: `test/${id}`,
    mime: 'audio/mpeg',
    durationMs: 10_000,
    ...patch,
  });
  return id;
}

describe('pipeline.start', () => {
  it('start creates project with format, topic, languages, empty doc and a running run in stage script with a queued pipeline.script job', async () => {
    const s = await pipelineApp();
    const st = settings({ topic: `${'Довга тема '.repeat(10)}${randomUUID()}` });
    const { projectId } = await s.caller.pipeline.start(st);
    const [p] = await s.deps.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p).toMatchObject({
      userId: LOCAL_USER_ID,
      format: '9:16',
      topic: st.topic,
      title: st.topic.slice(0, 80),
      baseLanguage: 'uk',
      languages: ['uk', 'en'],
    });
    const doc = normalizeDoc(p!.timeline);
    expect(doc.tracks).toEqual([]);
    expect(doc.segments ?? []).toEqual([]);
    // голоси мов запуску записано в проєкт (їх бере наявна озвучка)
    expect((p!.voice as { languages: Record<string, { voice?: VoiceChoice }> }).languages.en?.voice).toEqual(VOICE);

    const run = await runOf(s, projectId);
    expect(run).toMatchObject({ userId: LOCAL_USER_ID, stage: 'script', status: 'running', error: null });
    expect(run.settings).toEqual(st);
    const [job] = await projectJobs(s, 'pipeline.script', projectId);
    expect(job).toMatchObject({ id: run.scriptJobId, status: 'queued', payload: { projectId } });
  });

  it('start rejects unavailable image model (MODEL_UNAVAILABLE) before creating a project', async () => {
    const s = await pipelineApp();
    const st = settings({ imageModel: 'openai/gpt-image-2' as ModelRef });
    await expect(s.caller.pipeline.start(st)).rejects.toMatchObject({ cause: { code: 'MODEL_UNAVAILABLE' } });
    const rows = await s.deps.db.select().from(projects).where(eq(projects.topic, st.topic));
    expect(rows).toEqual([]);
  });

  it('start rejects unavailable text model (MODEL_UNAVAILABLE)', async () => {
    const s = await pipelineApp();
    await expect(
      s.caller.pipeline.start(settings({ textModel: 'anthropic/claude-opus-5-5' as ModelRef })),
    ).rejects.toMatchObject({ cause: { code: 'MODEL_UNAVAILABLE' } });
  });

  it('start rejects language without voice (VALIDATION)', async () => {
    const s = await pipelineApp();
    const st = settings({ voices: { uk: VOICE } });
    await expect(s.caller.pipeline.start(st)).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    await expect(
      s.caller.pipeline.start(settings({ voices: { uk: VOICE, en: { ...VOICE, voiceId: 'nobody' } } })),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    expect(await s.deps.db.select().from(projects).where(eq(projects.topic, st.topic))).toEqual([]);
  });

  it("start rejects someone else's music asset (NOT_FOUND)", async () => {
    const s = await pipelineApp();
    const [stranger] = await s.deps.db.insert(users).values({ name: 'Інший' }).returning();
    const foreign = await insertAsset(s, { userId: stranger!.id });
    await expect(s.caller.pipeline.start(settings({ musicAssetId: foreign }))).rejects.toMatchObject({
      cause: { code: 'NOT_FOUND' },
    });
    const image = await insertAsset(s, { kind: 'image', mime: 'image/png', width: 10, height: 10 });
    await expect(s.caller.pipeline.start(settings({ musicAssetId: image }))).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
    const own = await insertAsset(s);
    await expect(s.caller.pipeline.start(settings({ musicAssetId: own }))).resolves.toMatchObject({
      projectId: expect.any(String),
    });
  });

  it('estimate returns parts for the settings', async () => {
    const s = await pipelineApp();
    await expect(s.caller.pipeline.estimate(settings())).resolves.toEqual({
      usd: 0,
      parts: { script: 0, images: 0, tts: 0, stt: 0, translate: 0 },
    });
  });
});

describe('pipeline review', () => {
  it('get returns run, scenes in order with narration and language counters', async () => {
    const s = await pipelineApp();
    const { projectId } = await reviewRun(s);
    const v = await s.caller.pipeline.get({ projectId });
    expect(v.run).toMatchObject({ stage: 'review', status: 'awaiting_review', error: null, assembledVersion: null });
    expect(v.scenes.map((sc) => sc.narration)).toEqual(['Перша сцена.', 'Друга, трохи довша сцена.', 'Третя.']);
    expect(v.scenes[0]).toMatchObject({
      segmentId: 'seg-0',
      position: 0,
      visualPrompt: 'prompt 0',
      keywords: ['море'],
      status: 'empty',
      error: null,
      visual: null,
      suggestions: [],
      inTimeline: true,
      generationId: null,
    });
    // для сторінки сцен: шапка, версія для «Пересібрати», рядки сцени (події voice.* мають лише lineId)
    expect(v.project).toMatchObject({ id: projectId, format: '9:16', baseLanguage: 'uk' });
    expect(v.project.timelineVersion).toBeGreaterThanOrEqual(1);
    expect(v.scenes[0]!.lines.uk).toMatchObject({ id: expect.any(String), state: 'empty' });
    expect(v.languages).toEqual([
      { language: 'uk', ready: 0, total: 3, failed: 0 },
      { language: 'en', ready: 0, total: 3, failed: 0 },
    ]);
    expect(v.progress).toEqual({ done: 0, total: 9 });
  });

  it('get for a project without run → NOT_FOUND', async () => {
    const s = await pipelineApp();
    const { id } = await s.caller.projects.create({ title: 'Без запуску', format: '9:16' });
    await expect(s.caller.pipeline.get({ projectId: id })).rejects.toMatchObject({ cause: { code: 'NOT_FOUND' } });
  });

  it('updateScene writes narration to base line with text_origin script', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    const [first] = await scenesOf(s, runId);
    await s.caller.pipeline.updateScene({
      sceneId: first!.id,
      narration: 'Новий текст першої сцени, значно довший за попередній.',
      visualPrompt: 'black hole',
      keywords: ['космос', 'space'],
    });
    const [line] = await s.deps.db
      .select()
      .from(voiceLines)
      .where(
        and(eq(voiceLines.projectId, projectId), eq(voiceLines.segmentId, 'seg-0'), eq(voiceLines.language, 'uk')),
      );
    expect(line).toMatchObject({
      text: 'Новий текст першої сцени, значно довший за попередній.',
      textOrigin: 'script',
    });
    const [sc] = await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, first!.id));
    expect(sc).toMatchObject({ visualPrompt: 'black hole', keywords: ['космос', 'space'] });
    await expectSkeleton(s, projectId, runId);
  });

  it('updateScene rejected while the script is being written (VALIDATION)', async () => {
    const s = await pipelineApp();
    const { projectId } = await s.caller.pipeline.start(settings());
    const run = await writeScript(s, projectId, ['Одна.']);
    const [sc] = await scenesOf(s, run.id);
    await expect(s.caller.pipeline.updateScene({ sceneId: sc!.id, narration: 'x' })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
  });

  it('addScene/deleteScene/moveScene keep skeleton segments in scene order with estimated durations', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    const before = await scenesOf(s, runId);

    const { sceneId } = await s.caller.pipeline.addScene({
      projectId,
      after: before[0]!.id,
      narration: 'Вставлена сцена з новим текстом.',
    });
    let scenes = await scenesOf(s, runId);
    expect(scenes.map((sc) => sc.id)).toEqual([before[0]!.id, sceneId, before[1]!.id, before[2]!.id]);
    await expectSkeleton(s, projectId, runId);
    const v = await s.caller.pipeline.get({ projectId });
    expect(v.scenes[1]).toMatchObject({ id: sceneId, narration: 'Вставлена сцена з новим текстом.' });

    const appended = await s.caller.pipeline.addScene({ projectId, narration: 'Кінець.' });
    scenes = await scenesOf(s, runId);
    expect(scenes.at(-1)!.id).toBe(appended.sceneId);
    await expectSkeleton(s, projectId, runId);

    await s.caller.pipeline.moveScene({ sceneId: before[2]!.id, position: 0 });
    scenes = await scenesOf(s, runId);
    expect(scenes.map((sc) => sc.id)).toEqual([before[2]!.id, before[0]!.id, sceneId, before[1]!.id, appended.sceneId]);
    await expectSkeleton(s, projectId, runId);

    await s.caller.pipeline.deleteScene({ sceneId });
    scenes = await scenesOf(s, runId);
    expect(scenes.map((sc) => sc.id)).toEqual([before[2]!.id, before[0]!.id, before[1]!.id, appended.sceneId]);
    await expectSkeleton(s, projectId, runId);
  });

  it('add/delete/move rejected outside review (VALIDATION)', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    await s.deps.db.update(pipelineRuns).set({ stage: 'produce', status: 'running' }).where(eq(pipelineRuns.id, runId));
    const [sc] = await scenesOf(s, runId);
    const validation = { cause: { code: 'VALIDATION' } };
    await expect(s.caller.pipeline.addScene({ projectId, narration: 'x' })).rejects.toMatchObject(validation);
    await expect(s.caller.pipeline.deleteScene({ sceneId: sc!.id })).rejects.toMatchObject(validation);
    await expect(s.caller.pipeline.moveScene({ sceneId: sc!.id, position: 2 })).rejects.toMatchObject(validation);
    await expect(s.caller.pipeline.continue({ projectId })).rejects.toMatchObject(validation);
  });

  it('continue moves to produce and enqueues visuals and base synth', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    await s.caller.pipeline.continue({ projectId });
    const run = await runOf(s, projectId);
    expect(run).toMatchObject({ stage: 'produce', status: 'running' });
    const scenes = await scenesOf(s, runId);
    const visuals = await jobsOf(s, 'pipeline.visual');
    for (const sc of scenes) {
      expect(sc.status).toBe('queued');
      const job = visuals.find((j) => j.id === sc.jobId);
      expect(job).toMatchObject({ status: 'queued', payload: { sceneId: sc.id } });
    }
    const base = await s.deps.db
      .select()
      .from(voiceLines)
      .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.language, 'uk')));
    expect(base.map((l) => l.status)).toEqual(['queued', 'queued', 'queued']);
    expect(await projectJobs(s, 'voice.translate', projectId)).toHaveLength(1);
    // повторний виклик нічого не дублює
    await runAdvance(s.deps, runId);
    expect(await projectJobs(s, 'voice.translate', projectId)).toHaveLength(1);
    expect((await jobsOf(s, 'pipeline.visual')).filter((j) => scenes.some((sc) => sc.jobId === j.id))).toHaveLength(3);
  });

  it('script done → toProduce and visuals/synth enqueued in one runAdvance call', async () => {
    const s = await pipelineApp();
    const { projectId } = await s.caller.pipeline.start(settings({ stopAfterScript: false }));
    const run = await writeScript(s, projectId, ['Раз.', 'Два.']);
    await runAdvance(s.deps, run.id);
    expect(await runOf(s, projectId)).toMatchObject({ stage: 'produce', status: 'running' });
    const scenes = await scenesOf(s, run.id);
    expect(scenes.every((sc) => sc.status === 'queued' && sc.jobId)).toBe(true);
    expect(await projectJobs(s, 'voice.synthesize', projectId)).toHaveLength(0); // payload — lineId
    const lines = await s.deps.db.select().from(voiceLines).where(eq(voiceLines.projectId, projectId));
    expect(lines.every((l) => l.status === 'queued')).toBe(true);
  });

  it('script done with stopAfterScript → review / awaiting_review', async () => {
    const s = await pipelineApp();
    const { projectId } = await s.caller.pipeline.start(settings({ stopAfterScript: true }));
    const run = await writeScript(s, projectId, ['Раз.']);
    await runAdvance(s.deps, run.id);
    expect(await runOf(s, projectId)).toMatchObject({ stage: 'review', status: 'awaiting_review' });
    expect((await scenesOf(s, run.id))[0]!.status).toBe('empty');
  });

  it('parallel runAdvance calls enqueue each visual once', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    await s.deps.db.update(pipelineRuns).set({ stage: 'produce', status: 'running' }).where(eq(pipelineRuns.id, runId));
    const scenes = await scenesOf(s, runId);
    const visualsOfRun = async () =>
      (await jobsOf(s, 'pipeline.visual')).filter((j) =>
        scenes.some((sc) => (j.payload as { sceneId: string }).sceneId === sc.id),
      );
    await Promise.all([runAdvance(s.deps, runId), runAdvance(s.deps, runId), runAdvance(s.deps, runId)]);
    const visuals = await visualsOfRun();
    expect(visuals).toHaveLength(3);
    const after = await scenesOf(s, runId);
    expect(new Set(after.map((sc) => sc.jobId))).toEqual(new Set(visuals.map((j) => j.id)));
    expect(await projectJobs(s, 'voice.translate', projectId)).toHaveLength(1);

    // сам виконавець дії захищений умовою в БД (не лише чергою runAdvance)
    await s.deps.db.update(pipelineScenes).set({ status: 'failed' }).where(eq(pipelineScenes.id, scenes[0]!.id));
    await Promise.all(
      [1, 2, 3].map(() => executeAction(s.deps, runId, { type: 'enqueueVisual', sceneId: scenes[0]!.id })),
    );
    expect(await visualsOfRun()).toHaveLength(4);
  });

  it('enqueueAssemble moves produce → assemble once', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    await s.deps.db.update(pipelineRuns).set({ stage: 'produce', status: 'running' }).where(eq(pipelineRuns.id, runId));
    await Promise.all([1, 2, 3].map(() => executeAction(s.deps, runId, { type: 'enqueueAssemble' })));
    const run = await runOf(s, projectId);
    const assembles = await projectJobs(s, 'pipeline.assemble', projectId);
    expect(assembles).toHaveLength(1);
    expect(run).toMatchObject({ stage: 'assemble', assembleJobId: assembles[0]!.id });
  });

  it('sceneFailed takes the real error of the generation/job when present', async () => {
    const s = await pipelineApp();
    const { runId } = await reviewRun(s);
    await s.deps.db.update(pipelineRuns).set({ stage: 'produce', status: 'running' }).where(eq(pipelineRuns.id, runId));
    const [sc] = await scenesOf(s, runId);
    await executeAction(s.deps, runId, { type: 'enqueueVisual', sceneId: sc!.id });
    const [queued] = await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, sc!.id));
    await s.deps.db
      .update(jobs)
      .set({ status: 'failed', error: 'Справжня причина' })
      .where(eq(jobs.id, queued!.jobId!));
    await executeAction(s.deps, runId, { type: 'sceneFailed', sceneId: sc!.id, error: 'Загальний текст' });
    const [failed] = await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, sc!.id));
    expect(failed).toMatchObject({ status: 'failed', error: 'Справжня причина' });
    // кінцева сцена не перезаписується
    await executeAction(s.deps, runId, { type: 'sceneReady', sceneId: sc!.id });
    expect((await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, sc!.id)))[0]!.status).toBe(
      'failed',
    );
  });
});

describe('pipeline review fixes', () => {
  it('start returns the project even if the first advance fails (no duplicate on retry)', async () => {
    const s = await pipelineApp();
    failEnqueue(s, 'pipeline.script');
    const st = settings();
    const { projectId } = await s.caller.pipeline.start(st);
    expect(await runOf(s, projectId)).toMatchObject({ stage: 'script', status: 'running', scriptJobId: null });
    expect(await s.deps.db.select().from(projects).where(eq(projects.topic, st.topic))).toHaveLength(1);
  });

  it('translate that cannot be enqueued fails the language, and assemble still proceeds', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    const base = s.deps.ai;
    // ключ текстової моделі «видалено» після старту
    s.deps.ai = {
      ...base,
      catalog: async (u) =>
        (await base.catalog(u)).map((e) => (e.capability === 'text' ? { ...e, available: false } : e)),
    };
    await s.caller.pipeline.continue({ projectId });
    expect(await runOf(s, projectId)).toMatchObject({ stage: 'produce', status: 'running' });
    const en = await s.deps.db
      .select()
      .from(voiceLines)
      .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.language, 'en')));
    expect(en).toHaveLength(3);
    expect(en.every((l) => l.status === 'failed' && l.error?.includes('текстової моделі'))).toBe(true);
    expect((await loadSnapshot(s.deps, runId))!.langs.find((l) => l.language === 'en')!.translate).toBe('failed');
    expect(await projectJobs(s, 'voice.translate', projectId)).toHaveLength(0);

    // візуали й базова озвучка завершились → збірка
    await s.deps.db.update(pipelineScenes).set({ status: 'ready' }).where(eq(pipelineScenes.runId, runId));
    await s.deps.db
      .update(voiceLines)
      .set({ status: 'ready' })
      .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.language, 'uk')));
    await runAdvance(s.deps, runId);
    expect(await runOf(s, projectId)).toMatchObject({ stage: 'assemble', assembleJobId: expect.any(String) });
  });

  it('a failing action does not skip the reload pass after a state change', async () => {
    const s = await pipelineApp(['pipeline.script', 'pipeline.scene', 'pipeline.assemble']);
    failEnqueue(s, 'pipeline.visual');
    const { projectId } = await s.caller.pipeline.start(settings({ stopAfterScript: false }));
    const run = await writeScript(s, projectId, ['Раз.', 'Два.']);
    await expect(runAdvance(s.deps, run.id)).rejects.toMatchObject({ code: 'UNKNOWN_JOB_TYPE' });
    // toProduce змінив стан → наступний прохід поставив озвучку, хоч візуали й не вдалось поставити
    expect(await runOf(s, projectId)).toMatchObject({ stage: 'produce' });
    const lines = await s.deps.db
      .select()
      .from(voiceLines)
      .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.language, 'uk')));
    expect(lines.every((l) => l.status === 'queued')).toBe(true);
  });

  it('visual job_id is saved even if the handler already took the scene (running)', async () => {
    const s = await pipelineApp();
    const { runId } = await reviewRun(s);
    await s.deps.db.update(pipelineRuns).set({ stage: 'produce', status: 'running' }).where(eq(pipelineRuns.id, runId));
    const [sc] = await scenesOf(s, runId);
    const queue = s.deps.jobs.queue;
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (type, payload, opts) => {
      const id = await enqueue(type, payload, opts);
      if (type === 'pipeline.visual')
        await s.deps.db.update(pipelineScenes).set({ status: 'running' }).where(eq(pipelineScenes.id, sc!.id));
      return id;
    };
    await executeAction(s.deps, runId, { type: 'enqueueVisual', sceneId: sc!.id });
    const [after] = await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, sc!.id));
    expect(after).toMatchObject({ status: 'running', jobId: expect.any(String) });
  });

  it('addScene defaults visual prompt to narration and keywords to significant words', async () => {
    const s = await pipelineApp();
    const { projectId } = await reviewRun(s);
    const narration = 'Хмари над морем, і знову хмари на заході сонця.';
    const { sceneId } = await s.caller.pipeline.addScene({ projectId, narration });
    const [sc] = await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, sceneId));
    expect(sc).toMatchObject({ visualPrompt: narration, keywords: ['хмари', 'морем', 'знову', 'заході', 'сонця'] });
    expect(keywordsFrom('Я і ти.')).toEqual(['я']);
    expect(keywordsFrom('один два три чотири пʼять шість сім вісім девʼять десять одинадцять дванадцять')).toHaveLength(
      8,
    );
  });

  it('updateScene writes nothing when any part is invalid', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    const [sc] = await scenesOf(s, runId);
    const validation = { cause: { code: 'VALIDATION' } };
    await expect(
      s.caller.pipeline.updateScene({ sceneId: sc!.id, visualPrompt: 'new prompt', narration: 'x'.repeat(1501) }),
    ).rejects.toMatchObject(validation);
    // сегмента вже немає в документі
    await s.deps.db
      .update(projects)
      .set({ timeline: skeletonDoc('9:16', 30, [{ segmentId: 'seg-1', estimatedSec: 1 }]) })
      .where(eq(projects.id, projectId));
    await expect(
      s.caller.pipeline.updateScene({ sceneId: sc!.id, keywords: ['нове'], narration: 'Новий текст.' }),
    ).rejects.toMatchObject(validation);
    const [after] = await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, sc!.id));
    expect(after).toMatchObject({ visualPrompt: 'prompt 0', keywords: ['море'] });
    const [line] = await s.deps.db
      .select()
      .from(voiceLines)
      .where(
        and(eq(voiceLines.projectId, projectId), eq(voiceLines.segmentId, 'seg-0'), eq(voiceLines.language, 'uk')),
      );
    expect(line!.text).toBe('Перша сцена.');
  });
});

describe('pipeline cards and access', () => {
  it('projects.list shows pipeline progress', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    const { id: plain } = await s.caller.projects.create({ title: 'Звичайний', format: '9:16' });
    let cards = await s.caller.projects.list();
    expect(cards.find((c) => c.id === projectId)!.pipeline).toEqual({
      stage: 'review',
      status: 'awaiting_review',
      done: 0,
      total: 9,
    });
    expect(cards.find((c) => c.id === plain)!.pipeline).toBeNull();

    const [sc] = await scenesOf(s, runId);
    await s.deps.db.update(pipelineScenes).set({ status: 'ready' }).where(eq(pipelineScenes.id, sc!.id));
    await s.deps.db
      .update(voiceLines)
      .set({ status: 'failed' })
      .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.segmentId, 'seg-1')));
    cards = await s.caller.projects.list();
    expect(cards.find((c) => c.id === projectId)!.pipeline).toMatchObject({ done: 2, total: 9 });
  });

  it('other user gets NOT_FOUND', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    const [sc] = await scenesOf(s, runId);
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    const notFound = { cause: { code: 'NOT_FOUND' } };
    await expect(stranger.pipeline.get({ projectId })).rejects.toMatchObject(notFound);
    await expect(stranger.pipeline.updateScene({ sceneId: sc!.id, narration: 'x' })).rejects.toMatchObject(notFound);
    await expect(stranger.pipeline.addScene({ projectId, narration: 'x' })).rejects.toMatchObject(notFound);
    await expect(stranger.pipeline.deleteScene({ sceneId: sc!.id })).rejects.toMatchObject(notFound);
    await expect(stranger.pipeline.moveScene({ sceneId: sc!.id, position: 1 })).rejects.toMatchObject(notFound);
    await expect(stranger.pipeline.continue({ projectId })).rejects.toMatchObject(notFound);
    await expect(stranger.pipeline.updateScene({ sceneId: 'not-a-uuid', narration: 'x' })).rejects.toMatchObject(
      notFound,
    );
  });
});

type GenReq = { prompt: string; signal?: AbortSignal };

/** Fake-реєстр, що записує кожен `generateObject`; `override` може повернути власну відповідь (undefined — fake). */
function recordingAi(override?: (schema: unknown, req: GenReq, n: number) => Promise<unknown> | unknown) {
  const base = fakeAi();
  const calls: { schema: unknown; prompt: string; result: unknown }[] = [];
  const ai: AiRegistry = {
    ...base,
    text: async (userId, ref) => {
      const gen = await base.text(userId, ref);
      return {
        ...gen,
        generateObject: async (schema, req) => {
          const n = calls.length;
          const result = (await override?.(schema, req, n)) ?? (await gen.generateObject(schema, req));
          calls.push({ schema, prompt: req.prompt, result });
          return result as never;
        },
      };
    },
  };
  return { ai, calls };
}

/** Повний runtime (воркери + відновлення); візуал і збірка (T8/T9) — no-op заглушки. */
async function runtimeApp(ai: AiRegistry = fakeAi()) {
  const app = await createApp(testConfig(), { ai });
  opened.push(app);
  for (const type of ['pipeline.visual', 'pipeline.assemble'] as const)
    app.deps.jobs.runtime.register({ type, concurrency: 1, handler: async () => undefined });
  await app.start();
  const caller = appRouter.createCaller({ userId: LOCAL_USER_ID, deps: app.deps });
  return { ...app, caller };
}

const ukOnly = (over: Partial<PipelineSettings> = {}) =>
  settings({ languages: ['uk'], voices: { uk: VOICE }, ...over });
const T = { timeout: 20_000 };
const jobRow = async (s: App, id: string) => (await s.deps.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
const baseLines = (s: App, projectId: string) =>
  s.deps.db
    .select()
    .from(voiceLines)
    .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.language, 'uk')));

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  const { ai, calls } = recordingAi(async (schema) => {
    if (schema === scriptSchema && first) {
      first = false;
      await gate;
    }
    return undefined;
  });
  return { ai, calls, release };
}

describe('pipeline.script job', () => {
  it('start without stop → script job writes N scenes, base lines (text_origin script), skeleton segments matching scene ids, project title from script, stage produce', async () => {
    const { ai, calls } = recordingAi();
    const s = await runtimeApp(ai);
    const { projectId } = await s.caller.pipeline.start(ukOnly({ stopAfterScript: false }));
    await expect.poll(async () => (await runOf(s, projectId)).stage, T).toBe('produce');
    const run = await runOf(s, projectId);
    const scenes = await scenesOf(s, run.id);
    expect(scenes).toHaveLength(scenePlan('9:16', 45).scenes);
    const script = calls.find((c) => c.schema === scriptSchema)!.result as ScriptResult;
    expect(scenes.map((sc) => sc.visualPrompt)).toEqual(script.scenes.map((x) => x.visualPrompt));
    expect(scenes.map((sc) => sc.keywords)).toEqual(script.scenes.map((x) => x.keywords));
    const lines = await baseLines(s, projectId);
    const text = new Map(lines.map((l) => [l.segmentId, l]));
    expect(scenes.map((sc) => text.get(sc.segmentId)?.text)).toEqual(script.scenes.map((x) => x.narration));
    expect(lines.every((l) => l.textOrigin === 'script')).toBe(true);
    await expectSkeleton(s, projectId, run.id);
    const [p] = await s.deps.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p!.title).toBe(script.title);
    expect(await jobRow(s, run.scriptJobId!)).toMatchObject({ status: 'done', result: { scenes: scenes.length } });
    const [g] = await s.deps.db.select().from(generations).where(eq(generations.jobId, run.scriptJobId!));
    expect(g).toMatchObject({ capability: 'text', status: 'done', provider: 'fake' });
  }, 30_000);

  it('stopAfterScript → awaiting_review', async () => {
    const s = await runtimeApp();
    const { projectId } = await s.caller.pipeline.start(ukOnly({ stopAfterScript: true }));
    await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('awaiting_review');
    const run = await runOf(s, projectId);
    expect(run.stage).toBe('review');
    const scenes = await scenesOf(s, run.id);
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.every((sc) => sc.status === 'empty' && sc.jobId === null)).toBe(true);
  }, 30_000);

  it('16:9 900 s script runs outline then per-section scenes (fake outline), scene count from scenePlan', async () => {
    const { ai, calls } = recordingAi();
    const s = await runtimeApp(ai);
    const { projectId } = await s.caller.pipeline.start(
      ukOnly({ format: '16:9', targetSec: 900, stopAfterScript: true }),
    );
    await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('awaiting_review');
    const run = await runOf(s, projectId);
    expect(await scenesOf(s, run.id)).toHaveLength(scenePlan('16:9', 900).scenes);
    expect(calls[0]!.schema).toBe(outlineSchema);
    const outline = calls[0]!.result as OutlineResult;
    const sections = calls.slice(1);
    expect(sections).toHaveLength(outline.sections.length);
    expect(sections.every((c) => c.schema === scriptSchema)).toBe(true);
    expect(sections[0]!.prompt).toContain(`Розділ: ${outline.sections[0]!.title}`);
    // контекст — останні 3 сцени попереднього тексту
    const prev = (sections[0]!.result as ScriptResult).scenes.slice(-3).map((x) => `- ${x.narration}`);
    expect(sections[1]!.prompt).toContain(prev.join('\n'));
    const [p] = await s.deps.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p!.title).toBe(outline.title);
  }, 30_000);

  const invalid = {
    title: 'Невалідний',
    scenes: [{ narration: 'а'.repeat(1600), visualPrompt: 'x', keywords: ['k'] }],
  };

  it('invalid model output retried once with the errors in the prompt, then succeeds', async () => {
    const { ai, calls } = recordingAi((schema, _req, n) => (schema === scriptSchema && n === 0 ? invalid : undefined));
    const s = await runtimeApp(ai);
    const { projectId } = await s.caller.pipeline.start(ukOnly());
    await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('awaiting_review');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('Попередня відповідь була невалідною');
    expect(calls[1]!.prompt).toContain('1600');
    expect(await scenesOf(s, (await runOf(s, projectId)).id)).toHaveLength(scenePlan('9:16', 45).scenes);
  }, 30_000);

  it('invalid model output twice → run failed with message', async () => {
    const { ai, calls } = recordingAi((schema) => (schema === scriptSchema ? invalid : undefined));
    const s = await runtimeApp(ai);
    const { projectId } = await s.caller.pipeline.start(ukOnly());
    await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('failed');
    const run = await runOf(s, projectId);
    expect(calls).toHaveLength(2);
    expect(run.error).toContain('1500');
    expect(await scenesOf(s, run.id)).toHaveLength(0);
    const [g] = await s.deps.db.select().from(generations).where(eq(generations.jobId, run.scriptJobId!));
    expect(g!.status).toBe('failed');
  }, 30_000);

  it('deleting the project while the script job runs → job ends without throwing, no run rows left', async () => {
    const { ai, release } = gated();
    const s = await runtimeApp(ai);
    const { projectId } = await s.caller.pipeline.start(ukOnly());
    const run = await runOf(s, projectId);
    await expect.poll(async () => (await jobRow(s, run.scriptJobId!)).status, T).toBe('running');
    await s.deps.db.delete(projects).where(eq(projects.id, projectId));
    release();
    await expect.poll(async () => (await jobRow(s, run.scriptJobId!)).status, T).toBe('done');
    expect((await jobRow(s, run.scriptJobId!)).result).toEqual({ scenes: 0 });
    expect(await s.deps.db.select().from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId))).toEqual([]);
    expect(await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.runId, run.id))).toEqual([]);
    expect(await s.deps.db.select().from(voiceLines).where(eq(voiceLines.projectId, projectId))).toEqual([]);
    // сцени немає — pipeline.scene теж no-op
    const sceneJob = await s.deps.jobs.queue.enqueue(
      'pipeline.scene',
      { sceneId: randomUUID() },
      { userId: LOCAL_USER_ID },
    );
    await expect.poll(async () => (await jobRow(s, sceneJob)).status, T).toBe('done');
    expect((await jobRow(s, sceneJob)).result).toEqual({ ok: false });
  }, 30_000);
});

describe('pipeline cancel, retry, recovery', () => {
  it('cancel during script then retry → exactly one set of scenes', async () => {
    const { ai, release } = gated();
    const s = await runtimeApp(ai);
    const { projectId } = await s.caller.pipeline.start(ukOnly());
    const first = (await runOf(s, projectId)).scriptJobId!;
    await expect.poll(async () => (await jobRow(s, first)).status, T).toBe('running');
    await s.caller.pipeline.cancel({ projectId });
    expect(await runOf(s, projectId)).toMatchObject({ status: 'cancelled' });
    await expect(s.caller.pipeline.cancel({ projectId })).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });

    await s.caller.pipeline.retry({ projectId });
    const retried = await runOf(s, projectId);
    expect(retried.scriptJobId).not.toBe(first);
    await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('awaiting_review');
    // перша задача «дописує» вже після скасування — нічого не пише
    release();
    await expect.poll(async () => (await jobRow(s, first)).status, T).toBe('cancelled');
    const n = scenePlan('9:16', 45).scenes;
    expect(await scenesOf(s, retried.id)).toHaveLength(n);
    expect(await baseLines(s, projectId)).toHaveLength(n);
    await expectSkeleton(s, projectId, retried.id);
    await expect(s.caller.pipeline.retry({ projectId })).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
  }, 30_000);

  it('restart with interrupted script job → run failed with restart message, retry completes', async () => {
    const before = await pipelineApp(['pipeline.visual', 'pipeline.assemble']);
    const { projectId } = await before.caller.pipeline.start(ukOnly());
    const run = await runOf(before, projectId);
    // процес «упав» посеред задачі сценарію
    await before.deps.db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, run.scriptJobId!));
    const s = await runtimeApp();
    await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('failed');
    expect((await runOf(s, projectId)).error).toBe(RESTART_ERROR);
    await s.caller.pipeline.retry({ projectId });
    await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('awaiting_review');
    expect(await scenesOf(s, run.id)).toHaveLength(scenePlan('9:16', 45).scenes);
  }, 30_000);

  it('recovery advances running runs at startup (script job never enqueued)', async () => {
    const before = await pipelineApp();
    failEnqueue(before, 'pipeline.script');
    const { projectId } = await before.caller.pipeline.start(ukOnly());
    expect((await runOf(before, projectId)).scriptJobId).toBeNull();
    const s = await runtimeApp();
    await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('awaiting_review');
  }, 30_000);

  it('cancel during produce cancels visual, scene, generation and synth jobs; scenes → empty; retry re-queues', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    await s.caller.pipeline.continue({ projectId });
    const scenes = await scenesOf(s, runId);
    // сцена 0 — фото генерується; сцена 1 — перегенеровується текст
    const [g] = await s.deps.db
      .insert(generations)
      .values({ userId: LOCAL_USER_ID, capability: 'image', provider: 'fake', model: 'image', prompt: 'x', params: {} })
      .returning();
    const genJob = await s.deps.jobs.queue.enqueue(
      'image.generate',
      { generationId: g!.id },
      { userId: LOCAL_USER_ID },
    );
    await s.deps.db.update(generations).set({ jobId: genJob }).where(eq(generations.id, g!.id));
    await s.deps.db
      .update(pipelineScenes)
      .set({ generationId: g!.id, status: 'running' })
      .where(eq(pipelineScenes.id, scenes[0]!.id));
    const textJob = await s.deps.jobs.queue.enqueue(
      'pipeline.scene',
      { sceneId: scenes[1]!.id },
      { userId: LOCAL_USER_ID },
    );
    const synth = (await baseLines(s, projectId)).map((l) => l.jobId!);
    const [translate] = await projectJobs(s, 'voice.translate', projectId);
    expect(translate!.status).toBe('queued');
    expect(synth.every(Boolean)).toBe(true);

    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(stranger.pipeline.cancel({ projectId })).rejects.toMatchObject({ cause: { code: 'NOT_FOUND' } });
    await s.caller.pipeline.cancel({ projectId });
    expect(await runOf(s, projectId)).toMatchObject({ status: 'cancelled', stage: 'produce' });
    const status = async (id: string) => (await jobRow(s, id)).status;
    for (const id of [...scenes.map((sc) => sc.jobId!), genJob, textJob, ...synth])
      expect(await status(id)).toBe('cancelled');
    const after = await scenesOf(s, runId);
    expect(after.every((sc) => sc.status === 'empty' && sc.jobId === null)).toBe(true);
    expect(after[0]!.generationId).toBeNull();
    expect(await status(translate!.id)).toBe('cancelled');
    await expect
      .poll(async () => (await baseLines(s, projectId)).map((l) => l.status), T)
      .toEqual(['empty', 'empty', 'empty']);

    await s.caller.pipeline.retry({ projectId });
    expect(await runOf(s, projectId)).toMatchObject({ status: 'running', stage: 'produce', error: null });
    const again = await scenesOf(s, runId);
    expect(again.every((sc) => sc.status === 'queued' && sc.jobId && !scenes.some((o) => o.jobId === sc.jobId))).toBe(
      true,
    );
    expect((await baseLines(s, projectId)).every((l) => l.status === 'queued')).toBe(true);
    // скасований переклад поставлено знову
    const translates = await projectJobs(s, 'voice.translate', projectId);
    expect(translates).toHaveLength(2);
    expect(translates.find((j) => j.id !== translate!.id)!.status).toBe('queued');
  });

  it('a runAdvance racing with retry cannot assemble before the failed scene and translate are reset', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    const scenes = await scenesOf(s, runId);
    await s.deps.db.update(pipelineScenes).set({ status: 'ready' }).where(eq(pipelineScenes.runId, runId));
    await s.deps.db
      .update(pipelineScenes)
      .set({ status: 'failed', error: 'Fake: відмова' })
      .where(eq(pipelineScenes.id, scenes[0]!.id));
    await s.deps.db
      .update(voiceLines)
      .set({ status: 'ready' })
      .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.language, 'uk')));
    const failedTranslate = await s.deps.jobs.queue.enqueue(
      'voice.translate',
      { projectId, language: 'en' },
      { userId: LOCAL_USER_ID },
    );
    await s.deps.db.update(jobs).set({ status: 'failed', error: 'Збій' }).where(eq(jobs.id, failedTranslate));
    await s.deps.db
      .update(pipelineRuns)
      .set({ stage: 'produce', status: 'failed', error: 'Збій' })
      .where(eq(pipelineRuns.id, runId));

    // advance «з події» посеред retry — у момент постановки перекладу — і паралельні виклики
    const queue = s.deps.jobs.queue;
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (type, payload, opts) => {
      if (type === 'voice.translate') await runAdvance(s.deps, runId);
      return enqueue(type, payload, opts);
    };
    await Promise.all([s.caller.pipeline.retry({ projectId }), runAdvance(s.deps, runId), runAdvance(s.deps, runId)]);
    await runAdvance(s.deps, runId);
    expect(await projectJobs(s, 'pipeline.assemble', projectId)).toHaveLength(0);
    expect(await runOf(s, projectId)).toMatchObject({ stage: 'produce', status: 'running', assembleJobId: null });
    const [sc0] = await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, scenes[0]!.id));
    expect(sc0).toMatchObject({ status: 'queued', error: null });
    const translates = await projectJobs(s, 'voice.translate', projectId);
    expect(translates.filter((j) => j.status === 'queued')).toHaveLength(1);
  });

  it('retry after a failed assemble: back to produce, failed scene and failed lines re-queued, translate again', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    const assembleJob = await s.deps.jobs.queue.enqueue('pipeline.assemble', { projectId }, { userId: LOCAL_USER_ID });
    await s.deps.db.update(jobs).set({ status: 'failed', error: 'Збій збірки' }).where(eq(jobs.id, assembleJob));
    await s.deps.db
      .update(pipelineRuns)
      .set({ stage: 'assemble', status: 'failed', error: 'Збій збірки', assembleJobId: assembleJob })
      .where(eq(pipelineRuns.id, runId));
    const [g] = await s.deps.db
      .insert(generations)
      .values({
        userId: LOCAL_USER_ID,
        capability: 'image',
        provider: 'fake',
        model: 'image',
        prompt: 'x',
        params: {},
        status: 'failed',
        error: 'Fake: відмова',
      })
      .returning();
    const scenes = await scenesOf(s, runId);
    await s.deps.db.update(pipelineScenes).set({ status: 'ready' }).where(eq(pipelineScenes.runId, runId));
    await s.deps.db
      .update(pipelineScenes)
      .set({ status: 'failed', error: 'Fake: відмова', generationId: g!.id })
      .where(eq(pipelineScenes.id, scenes[0]!.id));
    await s.deps.db
      .update(voiceLines)
      .set({ status: 'ready' })
      .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.language, 'uk')));
    // переклад не вдалося поставити (як позначає runAdvance)
    await s.deps.db.insert(voiceLines).values(
      scenes.map((sc) => ({
        userId: LOCAL_USER_ID,
        projectId,
        segmentId: sc.segmentId,
        language: 'en',
        status: 'failed' as const,
        error: 'Немає ключа',
      })),
    );
    expect((await loadSnapshot(s.deps, runId))!.langs.find((l) => l.language === 'en')!.translate).toBe('failed');

    await s.caller.pipeline.retry({ projectId });
    const run = await runOf(s, projectId);
    expect(run).toMatchObject({ status: 'running', stage: 'produce', error: null, assembleJobId: null });
    const [sc0] = await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, scenes[0]!.id));
    expect(sc0).toMatchObject({ status: 'queued', error: null, generationId: null, jobId: expect.any(String) });
    const en = await s.deps.db
      .select()
      .from(voiceLines)
      .where(and(eq(voiceLines.projectId, projectId), eq(voiceLines.language, 'en')));
    expect(en.every((l) => l.status === 'empty' && l.error === null)).toBe(true);
    expect(await projectJobs(s, 'voice.translate', projectId)).toHaveLength(1);
  });
});

describe('pipeline.scene and event listener', () => {
  it('regenerateScene text rewrites narration, base line becomes voiced-stale', async () => {
    const { ai, calls } = recordingAi();
    const s = await runtimeApp(ai);
    const { projectId } = await s.caller.pipeline.start(ukOnly());
    await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('awaiting_review');
    const run = await runOf(s, projectId);
    const scenes = await scenesOf(s, run.id);
    const target = scenes[1]!;
    const [old] = (await baseLines(s, projectId)).filter((l) => l.segmentId === target.segmentId);
    const audio = await insertAsset(s);
    await s.deps.db
      .update(voiceLines)
      .set({ status: 'ready', audioAssetId: audio, voice: VOICE, voicedHash: voicedHash(old!.text, VOICE) })
      .where(eq(voiceLines.id, old!.id));
    expect((await getVoice(s.deps, LOCAL_USER_ID, projectId)).lines[target.segmentId]!.uk!.state).toBe('ready');

    const { jobId } = await s.caller.pipeline.regenerateScene({ sceneId: target.id, part: 'text' });
    await expect.poll(async () => (await jobRow(s, jobId)).status, T).toBe('done');
    const [line] = (await baseLines(s, projectId)).filter((l) => l.segmentId === target.segmentId);
    expect(line!.text).toBe(`Нова версія. ${old!.text}`);
    expect(line!.textOrigin).toBe('script');
    const [sc] = await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, target.id));
    expect(sc).toMatchObject({
      visualPrompt: `new version ${old!.text}`,
      keywords: ['fake'],
      status: 'empty',
      jobId: null,
    });
    expect((await getVoice(s.deps, LOCAL_USER_ID, projectId)).lines[target.segmentId]!.uk!.state).toBe('stale');
    const prompt = calls.at(-1)!.prompt;
    expect(prompt).toContain('Попередня сцена:');
    expect(prompt).toContain('Наступна сцена:');
    const [g] = await s.deps.db.select().from(generations).where(eq(generations.jobId, jobId));
    expect(g).toMatchObject({ capability: 'text', status: 'done' });
    // інші сцени без змін
    const others = (await baseLines(s, projectId)).filter((l) => l.segmentId !== target.segmentId);
    expect(others.every((l) => !l.text.startsWith('Нова версія.'))).toBe(true);
  }, 30_000);

  it('regenerateScene is rejected while the script is being written and for a stranger', async () => {
    const s = await pipelineApp();
    const { projectId, runId } = await reviewRun(s);
    const [sc] = await scenesOf(s, runId);
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(stranger.pipeline.regenerateScene({ sceneId: sc!.id, part: 'text' })).rejects.toMatchObject({
      cause: { code: 'NOT_FOUND' },
    });
    const a = await s.caller.pipeline.regenerateScene({ sceneId: sc!.id, part: 'text' });
    // повторне натискання, поки задача жива, не ставить другу
    const b = await s.caller.pipeline.regenerateScene({ sceneId: sc!.id, part: 'text' });
    expect(b.jobId).toBe(a.jobId);
    await s.deps.db.update(pipelineRuns).set({ stage: 'script', status: 'running' }).where(eq(pipelineRuns.id, runId));
    await expect(s.caller.pipeline.regenerateScene({ sceneId: sc!.id, part: 'text' })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
    expect(projectId).toBeTruthy();
  });

  it('event listener survives an event for a deleted project', async () => {
    const s = await pipelineApp(['pipeline.script', 'pipeline.scene', 'pipeline.assemble']);
    const errors: unknown[] = [];
    const deps = { ...s.deps, log: { error: (o: object) => void errors.push(o) } };
    const ev = (patch: Partial<JobEvent>): JobEvent => ({
      jobId: randomUUID(),
      userId: LOCAL_USER_ID,
      type: 'pipeline.script',
      subject: {},
      status: 'done',
      progress: 100,
      message: null,
      error: null,
      ...patch,
    });
    const { projectId } = await s.caller.pipeline.start(settings());
    const [sc] = await s.deps.db
      .insert(pipelineScenes)
      .values({ userId: LOCAL_USER_ID, runId: (await runOf(s, projectId)).id, segmentId: 'seg-x', position: 0 })
      .returning();
    await s.deps.db.delete(projects).where(eq(projects.id, projectId));
    await handlePipelineEvent(deps, ev({ subject: { projectId } }));
    await handlePipelineEvent(deps, ev({ type: 'pipeline.visual', subject: { sceneId: sc!.id } }));
    await handlePipelineEvent(deps, ev({ type: 'asset.process', subject: { assetId: randomUUID() } }));
    await handlePipelineEvent(deps, ev({ type: 'voice.synthesize', subject: { lineId: 'not-a-uuid' } }));
    await handlePipelineEvent(deps, ev({ type: 'image.generate', subject: { generationId: randomUUID() } }));
    expect(errors).toEqual([]);
    expect(pipelineEvents(deps)(ev({ subject: { projectId } }))).toBeUndefined();

    // advance падає (постановка pipeline.visual не вдається) — помилку журналюємо, слухач не кидає
    failEnqueue(s, 'pipeline.visual');
    const other = await reviewRun(s);
    await s.deps.db
      .update(pipelineRuns)
      .set({ stage: 'produce', status: 'running' })
      .where(eq(pipelineRuns.id, other.runId));
    const [first] = await scenesOf(s, other.runId);
    await handlePipelineEvent(deps, ev({ type: 'pipeline.scene', subject: { sceneId: first!.id } }));
    expect(errors).toHaveLength(1);
    // незавершені події не запускають advance
    await handlePipelineEvent(deps, ev({ type: 'pipeline.scene', status: 'running', subject: { sceneId: first!.id } }));
    expect(errors).toHaveLength(1);
  });
});

/** Fake-реєстр, у якому генерація фото з «HOLD» у промпті чекає `release()` (або скасування задачі). */
function holdingAi() {
  const base = fakeAi();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ai: AiRegistry = {
    ...base,
    image: async (userId, ref) => {
      const gen = await base.image(userId, ref);
      return {
        generate: async (req) => {
          if (req.prompt.includes('HOLD'))
            await Promise.race([gate, new Promise((r) => req.signal?.addEventListener('abort', r))]);
          return gen.generate(req);
        },
      };
    },
  };
  return { ai, release };
}

/** Повний runtime зі справжнім pipeline.visual (збірка — заглушка) і окремим користувачем із власною бібліотекою. */
async function visualApp(ai: AiRegistry = fakeAi()) {
  const app = await createApp(testConfig({ videoPollMs: 50 }), { ai });
  opened.push(app);
  app.deps.jobs.runtime.register({ type: 'pipeline.assemble', concurrency: 1, handler: async () => undefined });
  await app.start();
  const [u] = await app.deps.db.insert(users).values({ name: 'Конвеєр візуал' }).returning();
  freshUsers.push(u!.id);
  const caller = appRouter.createCaller({ userId: u!.id, deps: app.deps });
  return { ...app, caller, userId: u!.id };
}
type VApp = Awaited<ReturnType<typeof visualApp>>;

/** Фото в бібліотеці користувача (вертикальне, готове). */
async function libraryImage(s: VApp, patch: Partial<typeof assets.$inferInsert> = {}) {
  const id = randomUUID();
  await s.deps.db.insert(assets).values({
    id,
    userId: s.userId,
    kind: 'image',
    source: 'uploaded',
    status: 'ready',
    storageKey: `u/${s.userId}/assets/${id}/original.png`,
    mime: 'image/png',
    width: 1080,
    height: 1920,
    ...patch,
  });
  return id;
}

/** Запуск на 3 сцени (fake-сценарій), промпти й ключові слова сцен задано, далі «Продовжити». */
async function producedRun(s: VApp, scenes: { keywords: string[]; visualPrompt?: string }[]) {
  const { projectId } = await s.caller.pipeline.start(ukOnly({ targetSec: 15 }));
  await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('awaiting_review');
  const run = await runOf(s, projectId);
  const rows = await scenesOf(s, run.id);
  expect(rows).toHaveLength(scenes.length);
  for (const [i, sc] of scenes.entries())
    await s.caller.pipeline.updateScene({
      sceneId: rows[i]!.id,
      keywords: sc.keywords,
      visualPrompt: sc.visualPrompt ?? `calm abstract scene number ${i}`,
    });
  await s.caller.pipeline.continue({ projectId });
  return { projectId, runId: run.id, sceneIds: rows.map((r) => r.id) };
}

const sceneRow = async (s: App, id: string) =>
  (await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, id)))[0]!;
const settled = (st: string) => st === 'ready' || st === 'failed';
const V = { timeout: 30_000 };
const OTHER = [{ keywords: ['абстракція'] }, { keywords: ['абстракція'] }];

describe('pipeline.visual', () => {
  it('library asset with strong match is used, source library, no generation row', async () => {
    const s = await visualApp();
    const sunset = await libraryImage(s, { title: 'Захід сонця над морем', tags: ['море', 'захід'] });
    const { sceneIds } = await producedRun(s, [{ keywords: ['море', 'захід сонця'] }, ...OTHER]);
    await expect.poll(async () => (await sceneRow(s, sceneIds[0]!)).status, V).toBe('ready');
    expect(await sceneRow(s, sceneIds[0]!)).toMatchObject({
      visualAssetId: sunset,
      visualSource: 'library',
      generationId: null,
      error: null,
    });
    // інші сцени згенеровано; генерацій рівно дві (для сцени з бібліотеки — жодної)
    await expect
      .poll(async () => Promise.all(sceneIds.map(async (id) => settled((await sceneRow(s, id)).status))), V)
      .toEqual([true, true, true]);
    const gens = await s.deps.db
      .select()
      .from(generations)
      .where(and(eq(generations.userId, s.userId), eq(generations.capability, 'image')));
    expect(gens).toHaveLength(2);
  }, 40_000);

  it('weak matches land in suggestions and an image is generated', async () => {
    const s = await visualApp();
    const weak = await libraryImage(s, { title: 'Вода в склянці' });
    const [m] = await matchAssets(s.deps, s.userId, { keywords: ['водоспад'], format: '9:16', exclude: [] });
    expect(m).toMatchObject({ assetId: weak });
    expect(m!.score).toBeLessThan(LIBRARY_MATCH_MIN);
    const { projectId, sceneIds } = await producedRun(s, [{ keywords: ['водоспад'] }, ...OTHER]);
    await expect.poll(async () => (await sceneRow(s, sceneIds[0]!)).status, V).toBe('ready');
    const sc = await sceneRow(s, sceneIds[0]!);
    expect(sc.suggestions).toContain(weak);
    expect(sc.visualSource).toBe('generated');
    expect(sc.visualAssetId).not.toBe(weak);
    expect(sc.generationId).toBeTruthy();
    const view = await s.caller.pipeline.get({ projectId });
    expect(view.scenes[0]!.suggestions.map((x) => x.assetId)).toContain(weak);
  }, 40_000);

  it('same library file is not used for two scenes', async () => {
    const s = await visualApp();
    const sunset = await libraryImage(s, { title: 'Захід сонця над морем', tags: ['море', 'захід'] });
    const strong = { keywords: ['море', 'захід сонця'] };
    const { sceneIds } = await producedRun(s, [strong, strong, strong]);
    await expect
      .poll(async () => Promise.all(sceneIds.map(async (id) => settled((await sceneRow(s, id)).status))), V)
      .toEqual([true, true, true]);
    const rows = await Promise.all(sceneIds.map((id) => sceneRow(s, id)));
    expect(rows.filter((r) => r.visualAssetId === sunset)).toHaveLength(1);
    expect(rows.filter((r) => r.visualSource === 'generated')).toHaveLength(2);
  }, 40_000);

  it('generated image is linked when asset.process finishes, scene ready, asset tagged конвеєр', async () => {
    const s = await visualApp();
    const { projectId, sceneIds } = await producedRun(s, [
      { keywords: ['галактика', 'зорі'], visualPrompt: 'spiral galaxy in deep space' },
      ...OTHER,
    ]);
    await expect.poll(async () => (await sceneRow(s, sceneIds[0]!)).status, V).toBe('ready');
    const sc = await sceneRow(s, sceneIds[0]!);
    const [g] = await s.deps.db.select().from(generations).where(eq(generations.id, sc.generationId!));
    expect(g).toMatchObject({ status: 'done', prompt: 'spiral galaxy in deep space', capability: 'image' });
    expect(g!.params).toMatchObject({ aspect: '9:16', n: 1 });
    expect(sc).toMatchObject({ visualSource: 'generated', visualAssetId: g!.assetIds[0] });
    const [a] = await s.deps.db.select().from(assets).where(eq(assets.id, sc.visualAssetId!));
    expect(a!.status).toBe('ready');
    const topic = (await runOf(s, projectId)).settings.topic;
    const head = topic.trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase();
    expect(a!.tags).toEqual(expect.arrayContaining(['конвеєр', 'галактика', 'зорі', head]));
  }, 40_000);

  it('scene whose prompt contains FAIL is failed with provider message, other scenes ready', async () => {
    const s = await visualApp();
    const { sceneIds } = await producedRun(s, [{ keywords: ['галактика'], visualPrompt: 'FAIL please' }, ...OTHER]);
    await expect
      .poll(async () => Promise.all(sceneIds.map(async (id) => (await sceneRow(s, id)).status)), V)
      .toEqual(['failed', 'ready', 'ready']);
    expect((await sceneRow(s, sceneIds[0]!)).error).toBe('Fake: відмова');
  }, 40_000);

  it('regenerate visual skips library and creates a new generation', async () => {
    const { ai, release } = holdingAi();
    const s = await visualApp(ai);
    try {
      const sunset = await libraryImage(s, { title: 'Захід сонця над морем', tags: ['море', 'захід'] });
      const { projectId, sceneIds } = await producedRun(s, [
        { keywords: ['море', 'захід сонця'] },
        { keywords: ['абстракція'], visualPrompt: 'HOLD this one' },
        { keywords: ['абстракція'] },
      ]);
      await expect.poll(async () => (await sceneRow(s, sceneIds[0]!)).visualAssetId, V).toBe(sunset);
      await s.caller.pipeline.regenerateScene({ sceneId: sceneIds[0]!, part: 'visual' });
      expect(await sceneRow(s, sceneIds[0]!)).toMatchObject({ visualAssetId: null, visualSource: null });
      await expect.poll(async () => (await sceneRow(s, sceneIds[0]!)).status, V).toBe('ready');
      const sc = await sceneRow(s, sceneIds[0]!);
      expect(sc.visualSource).toBe('generated');
      expect(sc.visualAssetId).not.toBe(sunset);
      expect(sc.generationId).toBeTruthy();
      expect((await runOf(s, projectId)).stage).toBe('produce');
    } finally {
      release();
    }
  }, 40_000);

  it('generateSceneVideo links fake video when ready', async () => {
    const { ai, release } = holdingAi();
    const s = await visualApp(ai);
    try {
      const { sceneIds } = await producedRun(s, [
        { keywords: ['абстракція'] },
        { keywords: ['абстракція'], visualPrompt: 'HOLD this one' },
        { keywords: ['абстракція'] },
      ]);
      await expect.poll(async () => (await sceneRow(s, sceneIds[0]!)).status, V).toBe('ready');
      await expect(
        s.caller.pipeline.generateSceneVideo({ sceneId: sceneIds[0]!, model: 'fake/video', durationSec: 7 }),
      ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
      expect((await sceneRow(s, sceneIds[0]!)).status).toBe('ready');
      await s.caller.pipeline.generateSceneVideo({ sceneId: sceneIds[0]!, model: 'fake/video', durationSec: 2 });
      expect((await sceneRow(s, sceneIds[0]!)).status).toBe('running');
      await expect.poll(async () => (await sceneRow(s, sceneIds[0]!)).status, V).toBe('ready');
      const sc = await sceneRow(s, sceneIds[0]!);
      const [a] = await s.deps.db.select().from(assets).where(eq(assets.id, sc.visualAssetId!));
      expect(a).toMatchObject({ kind: 'video', status: 'ready' });
      expect(sc.visualSource).toBe('generated');
      expect(a!.tags).toContain('конвеєр');
    } finally {
      release();
    }
  }, 40_000);

  it("setSceneVisual rejects audio asset and someone else's asset", async () => {
    const s = await pipelineApp();
    const { runId } = await reviewRun(s);
    const [sc] = await scenesOf(s, runId);
    const audio = await insertAsset(s);
    const [stranger] = await s.deps.db.insert(users).values({ name: 'Чужий візуал' }).returning();
    freshUsers.push(stranger!.id);
    const foreign = await insertAsset(s, {
      userId: stranger!.id,
      kind: 'image',
      mime: 'image/png',
      width: 1080,
      height: 1920,
    });
    const pending = await insertAsset(s, { kind: 'image', mime: 'image/png', status: 'processing' });
    const own = await insertAsset(s, { kind: 'image', mime: 'image/png', width: 1080, height: 1920 });
    const call = (assetId: string) => s.caller.pipeline.setSceneVisual({ sceneId: sc!.id, assetId });
    await expect(call(audio)).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    await expect(call(pending)).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    await expect(call(foreign)).rejects.toMatchObject({ cause: { code: 'NOT_FOUND' } });
    await expect(call('not-a-uuid')).rejects.toMatchObject({ cause: { code: 'NOT_FOUND' } });
    const strangerCaller = appRouter.createCaller({ userId: stranger!.id, deps: s.deps });
    await expect(strangerCaller.pipeline.setSceneVisual({ sceneId: sc!.id, assetId: foreign })).rejects.toMatchObject({
      cause: { code: 'NOT_FOUND' },
    });
    expect((await sceneRow(s, sc!.id)).visualAssetId).toBeNull();
    await call(own);
    expect(await sceneRow(s, sc!.id)).toMatchObject({ visualAssetId: own, visualSource: 'manual', status: 'ready' });
  });

  it('visual job: aborted signal writes nothing; missing scene is a no-op', async () => {
    const s = await pipelineApp();
    const { runId } = await reviewRun(s);
    await s.deps.db.update(pipelineRuns).set({ stage: 'produce', status: 'running' }).where(eq(pipelineRuns.id, runId));
    const [sc] = await scenesOf(s, runId);
    await s.deps.db.update(pipelineScenes).set({ status: 'queued' }).where(eq(pipelineScenes.id, sc!.id));
    const ac = new AbortController();
    ac.abort();
    const ctx = { jobId: randomUUID(), userId: LOCAL_USER_ID, progress: async () => {}, signal: ac.signal };
    const job = visualJob(s.deps);
    expect(await job.handler({ sceneId: sc!.id }, ctx)).toEqual({ source: null });
    expect(await sceneRow(s, sc!.id)).toMatchObject({ status: 'queued', generationId: null, visualAssetId: null });
    const live = { ...ctx, signal: new AbortController().signal };
    expect(await job.handler({ sceneId: randomUUID() }, live)).toEqual({ source: null });
    // сцену видалено разом із проєктом посеред запуску — без винятку
    const { projectId } = await reviewRun(s);
    const [gone] = await scenesOf(s, (await runOf(s, projectId)).id);
    await s.deps.db.delete(projects).where(eq(projects.id, projectId));
    expect(await job.handler({ sceneId: gone!.id }, live)).toEqual({ source: null });
  });
});
