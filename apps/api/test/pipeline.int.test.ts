import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiRegistry, createEnvCredentialStore } from '@vf/ai';
import { assets, jobs, pipelineRuns, pipelineScenes, projects, users, voiceLines } from '@vf/db';
import { LOCAL_USER_ID, normalizeDoc, type ModelRef, type PipelineSettings, type VoiceChoice } from '@vf/shared';
import { estimateSceneSec, skeletonDoc } from '@vf/timeline';
import { appRouter, createApp } from '../src/index';
import { executeAction, runAdvance } from '../src/modules/pipeline/run-advance';
import { tools } from './assets-helpers';
import { testConfig } from './helpers';

const VOICE: VoiceChoice = { model: 'fake/tts' as ModelRef, voiceId: 'fake-voice' };
const fakeAi = () => createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }), media: tools });

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()));
});

/**
 * Застосунок без запуску воркерів: поставлені задачі лишаються `queued` (обробники pipeline.* — у T7–T9,
 * тут — заглушки, бо черга приймає лише зареєстровані типи).
 */
async function pipelineApp() {
  const app = await createApp(testConfig(), { ai: fakeAi() });
  opened.push(app);
  for (const type of ['pipeline.script', 'pipeline.scene', 'pipeline.visual', 'pipeline.assemble'] as const)
    app.deps.jobs.runtime.register({ type, concurrency: 1, handler: async () => undefined });
  const caller = appRouter.createCaller({ userId: LOCAL_USER_ID, deps: app.deps });
  return { ...app, caller };
}
type App = Awaited<ReturnType<typeof pipelineApp>>;

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
    });
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
