import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiRegistry, createEnvCredentialStore, type AiRegistry } from '@vf/ai';
import {
  assets,
  createDb,
  jobs,
  pipelineRuns,
  pipelineScenes,
  projects,
  renders,
  userSettings,
  users,
  voiceLines,
} from '@vf/db';
import {
  FORMATS,
  normalizeDoc,
  type JobStatus,
  type ModelRef,
  type PipelineSettings,
  type TimelineDoc,
  type VoiceChoice,
} from '@vf/shared';
import { docDuration } from '@vf/timeline';
import { appRouter, createApp, type AppDeps } from '../src/index';
import { parseVoice } from '../src/modules/voice/service';
import { ensureBlankAsset } from '../src/modules/pipeline/blank';
import { mp3Bytes, pngBytes, tools, upload, waitForAsset } from './assets-helpers';
import { testConfig } from './helpers';

const VOICE: VoiceChoice = { model: 'fake/tts' as ModelRef, voiceId: 'fake-voice' };
const FRAME = 1 / 30;
const T = { timeout: 60_000 };

const opened: { close(): Promise<void> }[] = [];
const freshUsers: string[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()));
  // тестова БД спільна: незавершені запуски підхопило б відновлення на старті API в інших тестах
  const probe = createDb(process.env.TEST_DATABASE_URL!);
  await probe.db.delete(projects).where(sql`${projects.id} in (select project_id from pipeline_runs)`);
  const gone = freshUsers.splice(0);
  if (gone.length) await probe.db.delete(users).where(inArray(users.id, gone));
  await probe.close();
});

/**
 * Fake-реєстр: озвучка тексту з «ГЛУХО» падає (або вся озвучка — `allTts`), фото з «HOLD» чекає `release()`
 * чи скасування задачі.
 */
function flowAi(o: { allTts?: boolean } = {}) {
  const base = createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }), media: tools });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ai: AiRegistry = {
    ...base,
    tts: async (userId, ref) => {
      const tts = await base.tts(userId, ref);
      return {
        ...tts,
        synthesize: async (req) => {
          if (o.allTts || req.text.includes('ГЛУХО')) throw new Error('Fake: озвучка не вдалася');
          return tts.synthesize(req);
        },
      };
    },
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

/** Повний runtime з усіма обробниками конвеєра і окремим користувачем (власна бібліотека, без шуму спільної БД). */
async function flowApp(ai: AiRegistry = flowAi().ai, overrides: Partial<AppDeps> = {}, userId?: string) {
  const app = await createApp(testConfig({ videoPollMs: 50 }), { ai, ...overrides });
  opened.push(app);
  await app.start();
  if (!userId) {
    const [u] = await app.deps.db.insert(users).values({ name: 'Конвеєр потік' }).returning();
    freshUsers.push(u!.id);
    userId = u!.id;
  }
  const caller = appRouter.createCaller({ userId, deps: app.deps });
  return { ...app, caller, userId };
}
type App = Awaited<ReturnType<typeof flowApp>>;

const settings = (over: Partial<PipelineSettings> = {}): PipelineSettings => ({
  topic: `Як працюють чорні діри ${randomUUID()}`,
  format: '9:16',
  targetSec: 15,
  style: '',
  baseLanguage: 'uk',
  languages: ['uk', 'en'],
  textModel: 'fake/text' as ModelRef,
  imageModel: 'fake/image' as ModelRef,
  voices: { uk: VOICE, en: VOICE },
  musicAssetId: null,
  stopAfterScript: false,
  ...over,
});

const runOf = async (s: App, projectId: string) =>
  (await s.deps.db.select().from(pipelineRuns).where(eq(pipelineRuns.projectId, projectId)))[0]!;
const scenesOf = (s: App, runId: string) =>
  s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.runId, runId)).orderBy(asc(pipelineScenes.position));
const sceneRow = async (s: App, id: string) =>
  (await s.deps.db.select().from(pipelineScenes).where(eq(pipelineScenes.id, id)))[0]!;
const projectRow = async (s: App, id: string) =>
  (await s.deps.db.select().from(projects).where(eq(projects.id, id)))[0]!;
const docOf = async (s: App, id: string) => normalizeDoc((await projectRow(s, id)).timeline);
const waitDone = (s: App, projectId: string) =>
  expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('done');

/** Нічого з задач користувача не в роботі (після done ще можуть доходити, напр., теги). */
async function waitIdle(s: App) {
  await expect
    .poll(async () => {
      const live = await s.deps.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.userId, s.userId), inArray(jobs.status, ['queued', 'running'] as JobStatus[])));
      return live.length;
    }, T)
    .toBe(0);
}

async function music(s: App) {
  const id = await upload(s.caller, 'music.mp3', 'audio/mpeg', await mp3Bytes());
  return (await waitForAsset(s.deps, id, ['ready'])).id;
}

/** Запуск зі зупинкою після сценарію: правки сцен (`edit(i)`), далі «Продовжити». */
async function editedRun(
  s: App,
  edit: (i: number) => { narration?: string; visualPrompt?: string },
  over: Partial<PipelineSettings> = {},
) {
  const { projectId } = await s.caller.pipeline.start(settings({ stopAfterScript: true, ...over }));
  await expect.poll(async () => (await runOf(s, projectId)).status, T).toBe('awaiting_review');
  const run = await runOf(s, projectId);
  const rows = await scenesOf(s, run.id);
  for (const [i, sc] of rows.entries()) {
    const patch = edit(i);
    if (patch.narration !== undefined || patch.visualPrompt !== undefined)
      await s.caller.pipeline.updateScene({ sceneId: sc.id, ...patch });
  }
  await s.caller.pipeline.continue({ projectId });
  return { projectId, runId: run.id, sceneIds: rows.map((r) => r.id) };
}

const videoClips = (doc: TimelineDoc) => doc.tracks.flatMap((t) => (t.kind === 'video' ? t.clips : []));
const segmentsSum = (doc: TimelineDoc) => (doc.segments ?? []).reduce((sum, sg) => sum + (sg.end - sg.start), 0);

/** Review Focus 1: сегменти впритул від 0 у межах документа, тривалість = сума сегментів. */
function expectFullDuration(doc: TimelineDoc) {
  const dur = docDuration(doc);
  expect(dur).toBeCloseTo(segmentsSum(doc), 6);
  expect(doc.segments![0]!.start).toBe(0);
  for (const sg of doc.segments!) {
    expect(sg.start).toBeGreaterThanOrEqual(0);
    expect(sg.end).toBeLessThanOrEqual(dur + 1e-6);
  }
}

describe('pipeline flow: assemble', () => {
  it('full run reaches done: doc has segments for every scene, one video clip per scene, music track, voice for uk and en ready, projects.voice has preset:shorts captions', async () => {
    const s = await flowApp();
    const musicId = await music(s);
    const { projectId } = await s.caller.pipeline.start(settings({ musicAssetId: musicId }));
    await waitDone(s, projectId);
    const run = await runOf(s, projectId);
    const p = await projectRow(s, projectId);
    const doc = normalizeDoc(p.timeline);
    const scenes = await scenesOf(s, run.id);
    expect(run).toMatchObject({ stage: 'done', status: 'done', error: null, assembledVersion: p.timelineVersion });
    expect(doc.segments!.map((sg) => sg.id)).toEqual(scenes.map((sc) => sc.segmentId));
    const clips = videoClips(doc);
    expect(clips).toHaveLength(scenes.length);
    expect(clips.map((c) => c.assetId)).toEqual(scenes.map((sc) => sc.visualAssetId));
    for (const [i, sg] of doc.segments!.entries()) {
      expect(clips[i]!.start).toBeCloseTo(sg.start, 6);
      expect(clips[i]!.start + clips[i]!.duration).toBeCloseTo(sg.end, 6);
    }
    const musicClips = doc.tracks.flatMap((t) => (t.kind === 'audio' && t.role === 'music' ? t.clips : []));
    expect(musicClips.length).toBeGreaterThan(0);
    expect(musicClips.every((c) => c.assetId === musicId)).toBe(true);
    const voiceIds = doc.tracks.flatMap((t) =>
      t.kind === 'audio' && t.role === 'voiceover' ? t.clips.map((c) => c.assetId) : [],
    );
    expect(p.assetIds.sort()).toEqual(
      [...new Set([...scenes.map((sc) => sc.visualAssetId!), musicId, ...voiceIds])].sort(),
    );
    expectFullDuration(doc);
    const baseVoiceTracks = doc.tracks.flatMap((t) => (t.kind === 'audio' && t.role === 'voiceover' ? [t] : []));
    expect(baseVoiceTracks).toHaveLength(1);
    expect(baseVoiceTracks[0]).toMatchObject({ language: 'uk' });
    expect(baseVoiceTracks[0]!.clips.map((c) => c.sceneId)).toEqual(scenes.map((sc) => sc.segmentId));

    const voice = await s.caller.voice.get({ projectId });
    for (const seg of voice.segments)
      for (const lang of ['uk', 'en']) expect(voice.lines[seg.id]?.[lang]?.state).toBe('ready');
    expect(p.voice).toMatchObject({
      languages: {
        uk: { voice: VOICE, captions: { enabled: true, styleId: 'preset:shorts' } },
        en: { voice: VOICE, captions: { enabled: true, styleId: 'preset:shorts' } },
      },
      original: { mode: 'replace' },
    });

    const uk = await s.caller.voice.localized({ projectId, language: 'uk' });
    expect(uk.fits).toHaveLength(scenes.length);
    expect(uk.fits.every((f) => f.speed === 1 && f.hold === 0)).toBe(true);
    const en = await s.caller.voice.localized({ projectId, language: 'en' });
    expect(en.timeline.tracks.some((t) => t.kind === 'audio' && t.role === 'voiceover' && t.clips.length)).toBe(true);
    expect(en.timeline.tracks.some((t) => t.kind === 'captions' && t.clips.length)).toBe(true);
    expect(en.subtitles).toBeTruthy();
  }, 90_000);

  it('reassemble: base voice unknown to the project and a different user default → still one voice clip per voiced scene, same durations', async () => {
    const OTHER: VoiceChoice = { model: 'fake/tts' as ModelRef, voiceId: 'other-voice' };
    const s = await flowApp();
    const { projectId } = await s.caller.pipeline.start(settings({ languages: ['uk'], voices: { uk: VOICE } }));
    await waitDone(s, projectId);
    await waitIdle(s);
    const before = await projectRow(s, projectId);
    // проєкт «забуває» голос бази, а голос за замовчуванням у користувача інший
    await s.deps.db
      .update(projects)
      .set({ voice: parseVoice({}) })
      .where(eq(projects.id, projectId));
    await s.deps.db
      .insert(userSettings)
      .values({ userId: s.userId, voices: { uk: OTHER } })
      .onConflictDoUpdate({ target: userSettings.userId, set: { voices: { uk: OTHER } } });
    await s.caller.pipeline.reassemble({ projectId, version: before.timelineVersion });
    await expect.poll(async () => (await runOf(s, projectId)).assembledVersion, T).toBe(before.timelineVersion + 1);
    await waitIdle(s);
    const run = await runOf(s, projectId);
    const doc = await docOf(s, projectId);
    const scenes = await scenesOf(s, run.id);
    const tracks = doc.tracks.flatMap((t) => (t.kind === 'audio' && t.role === 'voiceover' ? [t] : []));
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.clips.map((c) => c.sceneId)).toEqual(scenes.map((sc) => sc.segmentId));
    expect(doc.segments!.map((sg) => sg.end - sg.start)).toEqual(
      normalizeDoc(before.timeline).segments!.map((sg) => sg.end - sg.start),
    );
  }, 90_000);

  it('failed scene visual → blank asset clip, run still done; last scene blank keeps full duration', async () => {
    const s = await flowApp();
    const { projectId, runId } = await editedRun(s, (i) =>
      i === 2 ? { narration: 'Остання сцена ГЛУХО без голосу.', visualPrompt: 'FAIL last' } : {},
    );
    await waitDone(s, projectId);
    const scenes = await scenesOf(s, runId);
    expect(scenes.map((sc) => sc.status)).toEqual(['ready', 'ready', 'failed']);
    const doc = await docOf(s, projectId);
    const clips = videoClips(doc);
    expect(clips).toHaveLength(3);
    const [blank] = await s.deps.db.select().from(assets).where(eq(assets.id, clips[2]!.assetId));
    expect(blank).toMatchObject({
      userId: s.userId,
      kind: 'image',
      status: 'ready',
      source: 'generated',
      title: 'Порожня сцена',
      width: FORMATS['9:16'].width,
      height: FORMATS['9:16'].height,
    });
    expect(blank!.tags).toEqual(expect.arrayContaining(['заглушка', 'конвеєр']));
    expect(clips[2]!.effects).toEqual([]);
    expect(clips[0]!.effects[0]?.type).toBe('kenburns');
    // остання сцена без візуалу й без озвучки: документ і мовні версії не обрізають її
    expectFullDuration(doc);
    const last = doc.segments!.at(-1)!;
    expect(clips[2]!.start + clips[2]!.duration).toBeCloseTo(last.end, 6);
    for (const language of ['uk', 'en']) {
      const l = await s.caller.voice.localized({ projectId, language });
      expect(l.fits.map((f) => f.segmentId)).toEqual(doc.segments!.map((sg) => sg.id));
      expect(docDuration(l.timeline)).toBeGreaterThanOrEqual(docDuration(doc) - 1e-6);
    }
  }, 90_000);

  it('renders.start({ language: "en" }) on the draft produces an MP4 whose duration equals docDuration of localized en ±1 frame', async () => {
    const s = await flowApp();
    const musicId = await music(s);
    // найсуворіший випадок: остання сцена — заглушка без озвучки
    const { projectId } = await editedRun(
      s,
      (i) => (i === 2 ? { narration: 'Фінал ГЛУХО.', visualPrompt: 'FAIL last' } : {}),
      { musicAssetId: musicId },
    );
    await waitDone(s, projectId);
    await waitIdle(s);
    const p = await projectRow(s, projectId);
    const l = await s.caller.voice.localized({ projectId, language: 'en' });
    const { renderId } = await s.caller.renders.start({
      projectId,
      preset: 'draft',
      version: p.timelineVersion,
      language: 'en',
      force: true,
    });
    let a: typeof assets.$inferSelect | undefined;
    await expect
      .poll(
        async () => {
          const [r] = await s.deps.db.select().from(renders).where(eq(renders.id, renderId));
          if (r?.status === 'failed') throw new Error(`render failed: ${r.error}`);
          [a] = await s.deps.db.select().from(assets).where(eq(assets.id, renderId));
          return a?.status;
        },
        { timeout: 150_000, interval: 200 },
      )
      .toBe('ready');
    if (!a) throw new Error('render asset missing');
    expect(Math.abs(a.durationMs! - docDuration(l.timeline) * 1000)).toBeLessThanOrEqual(FRAME * 1000 + 1);
    expect(docDuration(l.timeline)).toBeGreaterThanOrEqual(docDuration(normalizeDoc(p.timeline)) - 1e-6);
  }, 240_000);

  it('all base voices failed → doc built from estimates, run done', async () => {
    const s = await flowApp(flowAi({ allTts: true }).ai);
    const { projectId, runId } = await editedRun(s, () => ({}), { languages: ['uk'], voices: { uk: VOICE } });
    await waitDone(s, projectId);
    const lines = await s.deps.db.select().from(voiceLines).where(eq(voiceLines.projectId, projectId));
    expect(lines.every((l) => l.status === 'failed')).toBe(true);
    const doc = await docOf(s, projectId);
    expect(doc.segments).toHaveLength((await scenesOf(s, runId)).length);
    expectFullDuration(doc);
    expect(videoClips(doc)).toHaveLength(doc.segments!.length);
  }, 90_000);

  it('music asset without duration → no music track, run done', async () => {
    const s = await flowApp();
    const id = randomUUID();
    await s.deps.db.insert(assets).values({
      id,
      userId: s.userId,
      kind: 'audio',
      source: 'uploaded',
      status: 'ready',
      storageKey: `u/${s.userId}/assets/${id}/original.mp3`,
      mime: 'audio/mpeg',
      durationMs: null,
    });
    const { projectId } = await s.caller.pipeline.start(
      settings({ musicAssetId: id, languages: ['uk'], voices: { uk: VOICE } }),
    );
    await waitDone(s, projectId);
    const doc = await docOf(s, projectId);
    expect(doc.tracks.some((t) => t.kind === 'audio' && t.role === 'music')).toBe(false);
    expect(videoClips(doc).length).toBeGreaterThan(0);
    expectFullDuration(doc);
  }, 90_000);

  it('restart during produce (stop runtime, start again) → run reaches done', async () => {
    const held = flowAi();
    const a = await flowApp(held.ai);
    const { projectId, runId } = await editedRun(a, (i) => (i === 0 ? { visualPrompt: 'HOLD restart' } : {}), {
      languages: ['uk'],
      voices: { uk: VOICE },
    });
    await expect.poll(async () => (await scenesOf(a, runId))[0]!.generationId, T).toBeTruthy();
    expect((await runOf(a, projectId)).stage).toBe('produce');
    await a.close();
    held.release();
    const b = await flowApp(flowAi().ai, {}, a.userId);
    await waitDone(b, projectId);
    const doc = await docOf(b, projectId);
    expect(videoClips(doc)).toHaveLength(doc.segments!.length);
    expectFullDuration(doc);
  }, 120_000);

  it('project deleted during produce → no exceptions, no running lines or scenes left', async () => {
    const errors: unknown[] = [];
    const held = flowAi();
    const s = await flowApp(held.ai, { log: { error: (obj: object, msg?: string) => void errors.push({ obj, msg }) } });
    try {
      const { projectId, runId } = await editedRun(s, (i) => (i === 0 ? { visualPrompt: 'HOLD delete' } : {}));
      await expect.poll(async () => (await scenesOf(s, runId))[0]!.generationId, T).toBeTruthy();
      await s.deps.db.delete(projects).where(eq(projects.id, projectId));
      held.release();
      await waitIdle(s);
      expect(await scenesOf(s, runId)).toHaveLength(0);
      expect(await s.deps.db.select().from(voiceLines).where(eq(voiceLines.projectId, projectId))).toHaveLength(0);
      const pipelineJobs = await s.deps.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.userId, s.userId), sql`${jobs.type} like 'pipeline.%'`));
      expect(pipelineJobs.filter((j) => j.status === 'failed')).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      held.release();
    }
  }, 90_000);

  it('blank asset created once for concurrent assembles of two runs', async () => {
    const s = await flowApp();
    const fail = () => ({ visualPrompt: 'FAIL everything' });
    const ukOnly = { languages: ['uk'], voices: { uk: VOICE } };
    const [r1, r2] = await Promise.all([editedRun(s, fail, ukOnly), editedRun(s, fail, ukOnly)]);
    await waitDone(s, r1.projectId);
    await waitDone(s, r2.projectId);
    const blanks = await s.deps.db
      .select()
      .from(assets)
      .where(and(eq(assets.userId, s.userId), sql`${assets.tags} @> array['заглушка']::text[]`));
    expect(blanks).toHaveLength(1);
    for (const r of [r1, r2])
      expect(videoClips(await docOf(s, r.projectId)).every((c) => c.assetId === blanks[0]!.id)).toBe(true);
    // прямі паралельні виклики — той самий файл; інший формат — окремий
    const [a, b, c] = await Promise.all([
      ensureBlankAsset(s.deps, s.userId, '9:16'),
      ensureBlankAsset(s.deps, s.userId, '9:16'),
      ensureBlankAsset(s.deps, s.userId, '16:9'),
    ]);
    expect(a.assetId).toBe(blanks[0]!.id);
    expect(b.assetId).toBe(blanks[0]!.id);
    expect(c).toMatchObject({ kind: 'image', blank: true, ...FORMATS['16:9'] });
    expect(c.assetId).not.toBe(a.assetId);
  }, 120_000);
});

describe('pipeline flow: after done', () => {
  it('after done: re-synthesizing a base line or processing an unrelated asset does not change timeline_version', async () => {
    const s = await flowApp();
    const { projectId } = await s.caller.pipeline.start(settings({ languages: ['uk'], voices: { uk: VOICE } }));
    await waitDone(s, projectId);
    await waitIdle(s);
    const before = await projectRow(s, projectId);
    const run = await runOf(s, projectId);
    const [first] = await scenesOf(s, run.id);
    const { jobIds } = await s.caller.voice.synthesize({ projectId, language: 'uk', segmentIds: [first!.segmentId] });
    expect(jobIds.length).toBeGreaterThan(0);
    const other = await upload(s.caller, 'other.png', 'image/png', await pngBytes(1080, 1920));
    await waitForAsset(s.deps, other, ['ready']);
    // повторна обробка файлу самої сцени теж не чіпає документ
    await s.deps.jobs.queue.enqueue('asset.process', { assetId: first!.visualAssetId! }, { userId: s.userId });
    await waitIdle(s);
    const after = await projectRow(s, projectId);
    expect(after.timelineVersion).toBe(before.timelineVersion);
    expect(after.timeline).toEqual(before.timeline);
    expect(await runOf(s, projectId)).toMatchObject({ stage: 'done', status: 'done' });
  }, 90_000);

  it('after done: a regenerated scene becomes ready only together with its swapped clip (one commit)', async () => {
    const s = await flowApp();
    const { projectId } = await s.caller.pipeline.start(settings({ languages: ['uk'], voices: { uk: VOICE } }));
    await waitDone(s, projectId);
    await waitIdle(s);
    const run = await runOf(s, projectId);
    const scenes = await scenesOf(s, run.id);
    const before = await projectRow(s, projectId);
    // утримуємо рядок проєкту: заміна кліпу чекає на замок; «ready» без неї не має стати видимим
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = s.deps.db.transaction(async (tx) => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      locked();
      await held;
    });
    await isLocked;
    try {
      await s.caller.pipeline.regenerateScene({ sceneId: scenes[1]!.id, part: 'visual' });
      await waitIdle(s);
      await new Promise((r) => setTimeout(r, 1500));
      expect((await sceneRow(s, scenes[1]!.id)).status).not.toBe('ready');
    } finally {
      release();
      await holder;
    }
    await expect.poll(async () => (await sceneRow(s, scenes[1]!.id)).status, T).toBe('ready');
    const sc = await sceneRow(s, scenes[1]!.id);
    const after = await projectRow(s, projectId);
    expect(after.timelineVersion).toBe(before.timelineVersion + 1);
    expect(videoClips(normalizeDoc(after.timeline))[1]!.assetId).toBe(sc.visualAssetId);
  }, 90_000);

  it("after done: regenerate visual replaces only that segment's clip, version +1", async () => {
    const s = await flowApp();
    const { projectId } = await s.caller.pipeline.start(settings({ languages: ['uk'], voices: { uk: VOICE } }));
    await waitDone(s, projectId);
    await waitIdle(s);
    const run = await runOf(s, projectId);
    const scenes = await scenesOf(s, run.id);
    const before = await projectRow(s, projectId);
    const doc0 = normalizeDoc(before.timeline);
    await s.caller.pipeline.regenerateScene({ sceneId: scenes[1]!.id, part: 'visual' });
    await expect
      .poll(async () => {
        const sc = await sceneRow(s, scenes[1]!.id);
        return sc.status === 'ready' && sc.visualAssetId !== scenes[1]!.visualAssetId;
      }, T)
      .toBe(true);
    await waitIdle(s);
    const sc = await sceneRow(s, scenes[1]!.id);
    const after = await projectRow(s, projectId);
    expect(after.timelineVersion).toBe(before.timelineVersion + 1);
    const doc1 = normalizeDoc(after.timeline);
    const [c0, c1] = [videoClips(doc0), videoClips(doc1)];
    expect(c1).toHaveLength(c0.length);
    expect(c1[0]).toEqual(c0[0]);
    expect(c1[2]).toEqual(c0[2]);
    expect(c1[1]).toMatchObject({ assetId: sc.visualAssetId, start: c0[1]!.start, duration: c0[1]!.duration });
    expect(c1[1]!.effects).toEqual(c0[1]!.effects);
    expect(doc1.segments).toEqual(doc0.segments);
    expect(after.assetIds).toContain(sc.visualAssetId);
    expect(after.assetIds).not.toContain(scenes[1]!.visualAssetId);

    // вибір з бібліотеки після done — так само точково
    const pick = await upload(s.caller, 'pick.png', 'image/png', await pngBytes(1080, 1920));
    await waitForAsset(s.deps, pick, ['ready']);
    await s.caller.pipeline.setSceneVisual({ sceneId: scenes[0]!.id, assetId: pick });
    const picked = await projectRow(s, projectId);
    expect(picked.timelineVersion).toBe(after.timelineVersion + 1);
    const c2 = videoClips(normalizeDoc(picked.timeline));
    expect(c2[0]).toMatchObject({ assetId: pick, start: c1[0]!.start, duration: c1[0]!.duration });
    expect(c2.slice(1)).toEqual(c1.slice(1));
    expect(await sceneRow(s, scenes[0]!.id)).toMatchObject({ visualAssetId: pick, visualSource: 'manual' });
  }, 120_000);

  it('after segment deleted in editor: regenerate leaves doc unchanged and inTimeline false', async () => {
    const s = await flowApp();
    const { projectId } = await s.caller.pipeline.start(settings({ languages: ['uk'], voices: { uk: VOICE } }));
    await waitDone(s, projectId);
    await waitIdle(s);
    const run = await runOf(s, projectId);
    const scenes = await scenesOf(s, run.id);
    const p = await projectRow(s, projectId);
    const doc = normalizeDoc(p.timeline);
    const edited: TimelineDoc = { ...doc, segments: doc.segments!.filter((sg) => sg.id !== scenes[1]!.segmentId) };
    const { version } = await s.caller.projects.save({
      id: projectId,
      timeline: edited,
      baseVersion: p.timelineVersion,
    });
    await s.caller.pipeline.regenerateScene({ sceneId: scenes[1]!.id, part: 'visual' });
    await expect
      .poll(async () => {
        const sc = await sceneRow(s, scenes[1]!.id);
        return sc.status === 'ready' && sc.visualAssetId !== scenes[1]!.visualAssetId;
      }, T)
      .toBe(true);
    await waitIdle(s);
    const after = await projectRow(s, projectId);
    expect(after.timelineVersion).toBe(version);
    expect(normalizeDoc(after.timeline)).toEqual(normalizeDoc((await projectRow(s, projectId)).timeline));
    const view = await s.caller.pipeline.get({ projectId });
    expect(view.scenes.map((x) => x.inTimeline)).toEqual([true, false, true]);
  }, 120_000);

  it('reassemble with stale version → CONFLICT; with current version → new doc version', async () => {
    const s = await flowApp();
    const { projectId } = await s.caller.pipeline.start(settings({ languages: ['uk'], voices: { uk: VOICE } }));
    await waitDone(s, projectId);
    await waitIdle(s);
    const p = await projectRow(s, projectId);
    await expect(s.caller.pipeline.reassemble({ projectId, version: p.timelineVersion - 1 })).rejects.toMatchObject({
      cause: { code: 'CONFLICT' },
    });
    await s.caller.pipeline.reassemble({ projectId, version: p.timelineVersion });
    await expect.poll(async () => (await runOf(s, projectId)).assembledVersion, T).toBe(p.timelineVersion + 1);
    await waitIdle(s);
    const after = await projectRow(s, projectId);
    expect(after.timelineVersion).toBe(p.timelineVersion + 1);
    expect(normalizeDoc(after.timeline).segments).toEqual(normalizeDoc(p.timeline).segments);
    expect(await runOf(s, projectId)).toMatchObject({ stage: 'done', status: 'done' });
  }, 90_000);

  it('visual changes are rejected on a cancelled or failed run (VALIDATION)', async () => {
    const s = await flowApp();
    const { projectId, runId, sceneIds } = await editedRun(s, (i) => (i === 0 ? { visualPrompt: 'HOLD stop' } : {}), {
      languages: ['uk'],
      voices: { uk: VOICE },
    });
    const pick = await upload(s.caller, 'p.png', 'image/png', await pngBytes(1080, 1920));
    await waitForAsset(s.deps, pick, ['ready']);
    await s.caller.pipeline.cancel({ projectId });
    const stopped = { cause: { code: 'VALIDATION', message: 'Запуск зупинено — натисніть «Повторити»' } };
    await expect(s.caller.pipeline.regenerateScene({ sceneId: sceneIds[1]!, part: 'visual' })).rejects.toMatchObject(
      stopped,
    );
    await expect(
      s.caller.pipeline.generateSceneVideo({ sceneId: sceneIds[1]!, model: 'fake/video' as ModelRef, durationSec: 2 }),
    ).rejects.toMatchObject(stopped);
    await expect(s.caller.pipeline.setSceneVisual({ sceneId: sceneIds[1]!, assetId: pick })).rejects.toMatchObject(
      stopped,
    );
    await s.deps.db.update(pipelineRuns).set({ status: 'failed' }).where(eq(pipelineRuns.id, runId));
    await expect(s.caller.pipeline.setSceneVisual({ sceneId: sceneIds[1]!, assetId: pick })).rejects.toMatchObject(
      stopped,
    );
  }, 90_000);
});
