import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  createAiRegistry,
  createEnvCredentialStore,
  type AiRegistry,
  type CatalogItem,
  type STT,
  type TTS,
} from '@vf/ai';
import { tokenize } from '@vf/captions';
import { assets, generations, jobs, pipelineRuns, projects, transcripts, voiceLines } from '@vf/db';
import { LOCAL_USER_ID, type PipelineSettings, type VoiceChoice, type Word } from '@vf/shared';
import { withDelivery } from '../src/modules/voice/choice';
import { voicedHash } from '../src/modules/voice/stale';
import { synthesizeJob } from '../src/modules/voice/synthesize-job';
import { executeAction } from '../src/modules/pipeline/run-advance';
import { tools } from './assets-helpers';
import { startApp } from './helpers';

type Started = Awaited<ReturnType<typeof startApp>>;
const VOICE: VoiceChoice = { model: 'fake/tts', voiceId: 'fake-voice' };
const T = 60_000;

/** Fake-TTS (0,4 с на слово, 0,6 с між абзацами) з хуком; `words: false` — без міток; `whisper` — STT для міток. */
function batchAi(
  o: {
    before?: (text: string, signal?: AbortSignal) => Promise<void> | void;
    words?: boolean;
    whisper?: STT;
    /** Модель озвучки в каталозі без міток слів (як OpenAI/Gemini TTS) */
    noTimestamps?: boolean;
  } = {},
): AiRegistry {
  const base = createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }), media: tools });
  return {
    ...base,
    async catalog(userId) {
      const list = await base.catalog(userId);
      return list.map((e) => {
        if (e.ref === 'openai/whisper-1') return { ...e, available: !!o.whisper } as CatalogItem;
        if (e.ref === 'fake/tts' && o.noTimestamps) return { ...e, wordTimestamps: false };
        return e;
      });
    },
    async tts(userId, ref) {
      const inner = await base.tts(userId, ref);
      const tts: TTS = {
        async synthesize(req) {
          await o.before?.(req.text, req.signal);
          const r = await inner.synthesize(req);
          return o.words === false ? { audio: r.audio } : r;
        },
      };
      return tts;
    },
    async stt(userId, ref) {
      if (ref === 'openai/whisper-1' && o.whisper) return o.whisper;
      return base.stt(userId, ref);
    },
  };
}

/** «Whisper» за підказкою (текстом озвучки) з тими ж мітками, що й fake-TTS; `drop` — слова, яких STT «не почув». */
const promptWhisper = (drop: (word: string, text: string) => boolean): STT => ({
  async transcribe(req) {
    const text = req.prompt ?? '';
    const words: Word[] = [];
    let t = 0;
    for (const para of text.split(/\n\s*\n/)) {
      const parts = para.split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      if (t) t += 600;
      for (const w of parts) {
        if (!drop(w, text)) words.push({ text: w, startMs: t, endMs: t + 400 });
        t += 400;
      }
    }
    return { text, segments: [], words };
  },
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const TERMINAL = ['done', 'failed', 'cancelled'];

/** Усі задачі озвучки проєкту (пакетні за projectId, окремі — за рядками) завершились. */
async function settle(s: Started, projectId: string) {
  return waitFor(async () => {
    const lineIds = (
      await s.deps.db.select({ id: voiceLines.id }).from(voiceLines).where(eq(voiceLines.projectId, projectId))
    ).map((l) => l.id);
    const rows = await s.deps.db
      .select()
      .from(jobs)
      .where(
        sql`${jobs.payload}->>'projectId' = ${projectId} or ${jobs.payload}->>'lineId' in (${sql.join(
          lineIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    return rows.length > 0 && rows.every((j) => TERMINAL.includes(j.status)) && rows;
  });
}

const segIds = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

/** Проєкт із n сегментами, база uk з голосом VOICE і текстами рядків (у порядку сегментів). */
async function batchProject(s: Started, texts: string[]) {
  const { id } = await s.caller.projects.create({ title: 'Пакет', format: '16:9' });
  const p = await s.caller.projects.get({ id });
  await s.caller.projects.save({
    id,
    baseVersion: p.version,
    timeline: {
      ...p.timeline,
      segments: segIds(texts.length).map((sid, i) => ({ id: sid, start: i * 2, end: i * 2 + 2 })),
    },
  });
  await s.caller.voice.setLanguages({ projectId: id, base: 'uk', languages: ['uk'] });
  await s.caller.voice.setVoice({ projectId: id, language: 'uk', voice: VOICE });
  // у зворотному порядку: пакет іде за порядком сегментів, а не рядків у БД
  for (const [i, text] of [...texts.entries()].reverse())
    await s.caller.voice.setText({ projectId: id, segmentId: `s${i + 1}`, language: 'uk', text });
  return id;
}

const linesOf = async (s: Started, projectId: string) => {
  const rows = await s.deps.db.select().from(voiceLines).where(eq(voiceLines.projectId, projectId));
  return segIds(rows.length).map((sid) => rows.find((r) => r.segmentId === sid)!);
};

const jobRow = async (s: Started, id: string) => (await s.deps.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

/** ~700 символів: два такі рядки — один шматок (≤ 1500), три — ні. */
const long = (marker: string) => `${marker} ${Array(62).fill('довгеслово').join(' ')}`;

describe('voice.synthesizeBatch', () => {
  it(
    '4 lines → 1 batch job, 4 ready lines with own assets and transcripts, durations sum ≈ take',
    async () => {
      const s = await startApp({}, { ai: batchAi() });
      const texts = ['Перший рядок тут', 'Другий рядок', 'Третій', 'Четвертий і останній'];
      const projectId = await batchProject(s, texts);
      const { jobIds } = await s.caller.voice.synthesize({ projectId });
      expect(jobIds).toHaveLength(1);
      const job = await jobRow(s, jobIds[0]!);
      expect(job.type).toBe('voice.synthesizeBatch');
      expect(job.payload).toMatchObject({ projectId, language: 'uk' });
      expect((job.payload as { lineIds: string[] }).lineIds).toEqual((await linesOf(s, projectId)).map((l) => l.id));
      await settle(s, projectId);
      expect((await jobRow(s, jobIds[0]!)).status).toBe('done');

      const lines = await linesOf(s, projectId);
      expect(lines.map((l) => l.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
      expect(lines.every((l) => l.jobId === jobIds[0])).toBe(true);
      expect(new Set(lines.map((l) => l.audioAssetId)).size).toBe(4);
      for (const [i, l] of lines.entries()) {
        const [a] = await s.deps.db.select().from(assets).where(eq(assets.id, l.audioAssetId!));
        expect(a).toMatchObject({ kind: 'audio', source: 'generated', status: 'ready', mime: 'audio/wav' });
        expect(Math.abs(a!.durationMs! - l.durationMs!)).toBeLessThanOrEqual(5);
        const [t] = await s.deps.db.select().from(transcripts).where(eq(transcripts.id, l.transcriptId!));
        expect(t).toMatchObject({ source: 'tts', timing: 'aligned', language: 'uk', assetId: a!.id, text: texts[i] });
        expect(t!.words.map((w) => w.text)).toEqual(tokenize(texts[i]!).map((x) => x.text));
        expect(t!.words[0]!.startMs).toBeGreaterThanOrEqual(0);
        expect(t!.words.at(-1)!.endMs).toBeLessThanOrEqual(l.durationMs!);
      }
      // дубль: 9 слів × 0,4 с + 3 паузи × 0,6 с
      const sum = lines.reduce((acc, l) => acc + l.durationMs!, 0);
      expect(Math.abs(sum - 5400)).toBeLessThanOrEqual(30);

      const gens = await s.deps.db.select().from(generations).where(eq(generations.jobId, jobIds[0]!));
      expect(gens).toHaveLength(1);
      expect(gens[0]).toMatchObject({ capability: 'tts', status: 'done' });
      expect((gens[0]!.params as { lineIds: string[] }).lineIds).toEqual(lines.map((l) => l.id));
      expect([...gens[0]!.assetIds!].sort()).toEqual(lines.map((l) => l.audioAssetId!).sort());
      expect(gens[0]!.prompt).toBe(texts.join('\n\n'));
    },
    T,
  );

  it(
    'ready line voicedHash equals what voice.synthesize would write',
    async () => {
      const s = await startApp({}, { ai: batchAi() });
      const texts = ['Раз два', 'Три чотири'];
      const projectId = await batchProject(s, texts);
      await s.caller.voice.synthesize({ projectId });
      await settle(s, projectId);
      const lines = await linesOf(s, projectId);
      for (const [i, l] of lines.entries()) {
        expect(l).toMatchObject({ status: 'ready', voicedHash: voicedHash(texts[i]!, withDelivery(VOICE, 'uk')) });
        expect(l.voice).toEqual(withDelivery(VOICE, 'uk'));
      }
      // voice.synthesize бачить той самий хеш — нової озвучки не робить
      const [j] = await s.deps.db
        .insert(jobs)
        .values({ userId: LOCAL_USER_ID, type: 'voice.synthesize', payload: {}, status: 'running' })
        .returning();
      const ctx = {
        jobId: j!.id,
        userId: LOCAL_USER_ID,
        progress: async () => {},
        signal: new AbortController().signal,
      };
      expect(await synthesizeJob(s.deps).handler({ lineId: lines[0]!.id }, ctx)).toEqual({
        assetId: lines[0]!.audioAssetId,
      });
      expect((await s.caller.voice.get({ projectId })).lines.s1!.uk!.state).toBe('ready');
    },
    T,
  );

  it(
    'unreliable boundary → those lines re-enqueued as voice.synthesize, others ready',
    async () => {
      // STT не «почув» останнє слово другого рядка — лише в пакеті (у тексті є абзаци)
      const whisper = promptWhisper((w, text) => w === 'кінець' && text.includes('\n\n'));
      const s = await startApp({}, { ai: batchAi({ words: false, whisper }) });
      const texts = ['Перший рядок', 'Другий рядок кінець', 'Третій рядок', 'Четвертий рядок'];
      const projectId = await batchProject(s, texts);
      const { jobIds } = await s.caller.voice.synthesize({ projectId });
      expect(jobIds).toHaveLength(1);
      await waitFor(async () => (await jobRow(s, jobIds[0]!)).status === 'done');
      await settle(s, projectId);

      const lines = await linesOf(s, projectId);
      expect(lines.map((l) => l.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
      expect(lines[0]!.jobId).toBe(jobIds[0]);
      expect(lines[3]!.jobId).toBe(jobIds[0]);
      for (const l of [lines[1]!, lines[2]!]) {
        expect(l.jobId).not.toBe(jobIds[0]);
        expect(await jobRow(s, l.jobId!)).toMatchObject({
          type: 'voice.synthesize',
          status: 'done',
          payload: { lineId: l.id },
        });
      }
      const single = await s.deps.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.type, 'voice.synthesize'),
            inArray(
              sql`${jobs.payload}->>'lineId'`,
              lines.map((l) => l.id),
            ),
          ),
        );
      expect(single).toHaveLength(2);
      const view = (await s.caller.voice.get({ projectId })).lines;
      expect(view.s2!.uk!.words!.map((w) => w.text)).toEqual(['Другий', 'рядок', 'кінець']);
      expect(view.s1!.uk).toMatchObject({ state: 'ready', timing: 'aligned' });
    },
    T,
  );

  it(
    'chunk TTS error → its lines failed, other chunks ready',
    async () => {
      const s = await startApp(
        {},
        {
          ai: batchAi({
            before: (text) => {
              if (text.includes('ПОГАНЕ')) throw new Error('Контент-політика провайдера');
            },
          }),
        },
      );
      const projectId = await batchProject(s, [long('один'), long('два'), long('ПОГАНЕ'), long('чотири')]);
      const { jobIds } = await s.caller.voice.synthesize({ projectId });
      expect(jobIds).toHaveLength(1);
      await settle(s, projectId);
      expect(await jobRow(s, jobIds[0]!)).toMatchObject({ status: 'failed', error: 'Контент-політика провайдера' });
      const lines = await linesOf(s, projectId);
      expect(lines.map((l) => l.status)).toEqual(['ready', 'ready', 'failed', 'failed']);
      expect(lines[2]!.error).toBe('Контент-політика провайдера');
      const gens = await s.deps.db.select().from(generations).where(eq(generations.jobId, jobIds[0]!));
      expect(gens.map((g) => g.status).sort()).toEqual(['done', 'failed']);
      const failed = gens.find((g) => g.status === 'failed')!;
      expect((failed.params as { lineIds: string[] }).lineIds).toEqual([lines[2]!.id, lines[3]!.id]);
    },
    T,
  );

  it(
    'cancel mid-batch → no line left running, ready lines stay ready (Review Focus 4)',
    async () => {
      let entered = false;
      const s = await startApp(
        {},
        {
          ai: batchAi({
            before: (text, signal) => {
              if (!text.includes('ЧЕКАЙ')) return;
              return new Promise((_, reject) => {
                entered = true;
                signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
              });
            },
          }),
        },
      );
      const projectId = await batchProject(s, [long('один'), long('два'), long('ЧЕКАЙ'), long('чотири')]);
      // четвертий рядок раніше озвучено іншим текстом (застарілий) — після скасування лишається з попередньою озвучкою
      const old = await s.deps.db
        .insert(assets)
        .values({
          userId: LOCAL_USER_ID,
          kind: 'audio',
          source: 'generated',
          status: 'ready',
          storageKey: `test/${randomUUID()}`,
          mime: 'audio/wav',
          durationMs: 1000,
          title: 'стара озвучка',
        })
        .returning({ id: assets.id });
      const fourth = (await linesOf(s, projectId))[3]!;
      await s.deps.db
        .update(voiceLines)
        .set({
          status: 'ready',
          audioAssetId: old[0]!.id,
          voice: withDelivery(VOICE, 'uk'),
          voicedHash: voicedHash('старий текст', withDelivery(VOICE, 'uk')),
          durationMs: 1000,
        })
        .where(eq(voiceLines.id, fourth.id));

      const { jobIds } = await s.caller.voice.synthesize({ projectId });
      expect(jobIds).toHaveLength(1);
      await waitFor(async () => entered);
      expect((await linesOf(s, projectId)).map((l) => l.status)).toEqual(['ready', 'ready', 'running', 'running']);
      await s.deps.jobs.queue.cancel(jobIds[0]!);
      await waitFor(async () => (await jobRow(s, jobIds[0]!)).status === 'cancelled');
      await waitFor(async () =>
        (await linesOf(s, projectId)).every((l) => l.status !== 'running' && l.status !== 'queued'),
      );

      const lines = await linesOf(s, projectId);
      expect(lines.map((l) => l.status)).toEqual(['ready', 'ready', 'empty', 'ready']);
      expect(lines[3]!.audioAssetId).toBe(old[0]!.id);
      expect(lines.every((l) => l.error === null)).toBe(true);
      const view = (await s.caller.voice.get({ projectId })).lines;
      expect([view.s1!.uk!.state, view.s2!.uk!.state, view.s3!.uk!.state, view.s4!.uk!.state]).toEqual([
        'ready',
        'ready',
        'empty',
        'stale',
      ]);
      const gens = await s.deps.db.select().from(generations).where(eq(generations.jobId, jobIds[0]!));
      expect(gens.map((g) => g.status).sort()).toEqual(['cancelled', 'done']);
    },
    T,
  );

  it(
    'single line → voice.synthesize as before',
    async () => {
      const s = await startApp({}, { ai: batchAi() });
      const projectId = await batchProject(s, ['Лише один рядок']);
      const { jobIds } = await s.caller.voice.synthesize({ projectId });
      expect(jobIds).toHaveLength(1);
      const lines = await linesOf(s, projectId);
      expect(await jobRow(s, jobIds[0]!)).toMatchObject({
        type: 'voice.synthesize',
        payload: { lineId: lines[0]!.id },
      });
      await settle(s, projectId);
      expect((await linesOf(s, projectId))[0]).toMatchObject({ status: 'ready', durationMs: 1200 });
    },
    T,
  );

  it(
    'TTS without word timings and no whisper → a job per line (a batch could not be cut)',
    async () => {
      const s = await startApp({}, { ai: batchAi({ words: false, noTimestamps: true }) });
      const projectId = await batchProject(s, ['Раз два', 'Три чотири']);
      const { jobIds } = await s.caller.voice.synthesize({ projectId });
      expect(jobIds).toHaveLength(2);
      for (const id of jobIds) expect((await jobRow(s, id)).type).toBe('voice.synthesize');
      await settle(s, projectId);
      expect((await linesOf(s, projectId)).map((l) => l.status)).toEqual(['ready', 'ready']);
    },
    T,
  );

  it(
    'pipeline enqueue of 3 empty lines → one batch job',
    async () => {
      const s = await startApp({}, { ai: batchAi() });
      const projectId = await batchProject(s, ['Сцена один', 'Сцена два', 'Сцена три']);
      const [run] = await s.deps.db
        .insert(pipelineRuns)
        .values({
          userId: LOCAL_USER_ID,
          projectId,
          settings: { baseLanguage: 'uk', languages: ['uk'] } as unknown as PipelineSettings,
          stage: 'done',
          status: 'done',
        })
        .returning();
      try {
        await executeAction(s.deps, run!.id, { type: 'enqueueSynthesize', language: 'uk' });
        const batch = await s.deps.db
          .select()
          .from(jobs)
          .where(and(eq(jobs.type, 'voice.synthesizeBatch'), sql`${jobs.payload}->>'projectId' = ${projectId}`));
        expect(batch).toHaveLength(1);
        const lines = await linesOf(s, projectId);
        expect(lines.every((l) => l.jobId === batch[0]!.id)).toBe(true);
        await settle(s, projectId);
        expect((await linesOf(s, projectId)).map((l) => l.status)).toEqual(['ready', 'ready', 'ready']);
      } finally {
        await s.deps.db.delete(projects).where(eq(projects.id, projectId));
      }
    },
    T,
  );
});
