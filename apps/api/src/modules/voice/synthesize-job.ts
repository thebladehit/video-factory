import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alignWordsDetailed, estimateWords } from '@vf/captions';
import { assets, projects, transcripts, voiceLines } from '@vf/db';
import type { JobContext, JobDef } from '@vf/jobs';
import { probe, speechIntervals } from '@vf/media';
import { assetKeys, languageInfo, normalizeTags, type JobEvent, type VoiceChoice, type Word } from '@vf/shared';
import type { AppDeps } from '../../app';
import { analyzeAsset } from '../assets/analyze-job';
import { isUuid } from '../projects/editor-assets';
import { finishGeneration, isCancelled, startGeneration } from './job-utils';
import { STT_MODEL, voiceForLanguage } from './service';
import { voicedHash } from './stale';

export type Timing = 'aligned' | 'estimated';

/**
 * Мітки слів (4.1): слова від TTS, якщо є; інакше whisper-1 по згенерованому аудіо + `alignWords`;
 * без whisper — `estimateWords` за інтервалами мовлення (`timing: 'estimated'`).
 * `matched[i]` — мітка слова справжня: слова TTS — так; вирівняні whisper — за `alignWordsDetailed`; оцінені — ні.
 */
export async function wordTimings(
  deps: AppDeps,
  req: {
    userId: string;
    jobId: string;
    text: string;
    language: string;
    wavPath: string;
    bytes: Uint8Array;
    durationMs: number;
    ttsWords?: Word[];
    signal: AbortSignal;
  },
): Promise<{ words: Word[]; timing: Timing; matched: boolean[] }> {
  if (req.ttsWords?.length) return { words: req.ttsWords, timing: 'aligned', matched: req.ttsWords.map(() => true) };
  const whisper = (await deps.ai.catalog(req.userId)).find(
    (e) => e.ref === STT_MODEL && e.capability === 'stt' && e.available,
  );
  if (whisper) {
    const genId = await startGeneration(deps, {
      userId: req.userId,
      capability: 'stt',
      ref: STT_MODEL,
      prompt: req.text,
      params: { purpose: 'word-timings', language: req.language },
      jobId: req.jobId,
    });
    try {
      const r = await (
        await deps.ai.stt(req.userId, STT_MODEL)
      ).transcribe({
        audio: req.bytes,
        mime: 'audio/wav',
        language: req.language,
        prompt: req.text,
        signal: req.signal,
      });
      await finishGeneration(deps, genId, {
        status: 'done',
        entry: whisper,
        usage: { durationSec: req.durationMs / 1000 },
      });
      if (r.words?.length) return { ...alignWordsDetailed(req.text, r.words), timing: 'aligned' };
    } catch (e) {
      if (isCancelled(e, req.signal)) {
        await finishGeneration(deps, genId, { status: 'cancelled' });
        throw e;
      }
      // помилка whisper не має губити вже оплачену озвучку — мітки оцінюються (4.1)
      await finishGeneration(deps, genId, { status: 'failed', error: (e as Error).message });
    }
  }
  let speech: { startMs: number; endMs: number }[] = [];
  try {
    speech = await speechIntervals(deps.media, req.wavPath, { signal: req.signal });
  } catch (e) {
    // файл без аудіопотоку чи нечитабельний — слова рівномірно на всю тривалість
    if (isCancelled(e, req.signal)) throw e;
  }
  const words = estimateWords(req.text, req.durationMs, speech);
  return { words, timing: 'estimated', matched: words.map(() => false) };
}

/**
 * Готовий дубль рядка: wav у сховище → asset `audio` (ready, з аналізом звуку) → транскрипт `tts` → рядок `ready`
 * з `voiced_hash` від знімка тексту й голосу. Рядок оновлюється, лише якщо досі належить задачі `ctx.jobId`.
 * Повертає id asset; при збої прибирає завантажений об'єкт.
 */
export async function saveLineTake(
  deps: AppDeps,
  ctx: Pick<JobContext, 'jobId' | 'signal'>,
  line: Pick<typeof voiceLines.$inferSelect, 'id' | 'userId' | 'language'>,
  take: {
    bytes: Uint8Array;
    wavPath: string;
    durationMs: number;
    words: Word[];
    timing: Timing;
    voice: VoiceChoice;
    text: string;
    projectTitle: string;
    generationId: string;
  },
): Promise<string> {
  const assetId = randomUUID();
  const key = assetKeys.original(line.userId, assetId, 'wav');
  await deps.storage.put(key, take.bytes, { contentType: 'audio/wav' });
  try {
    const sound = await analyzeAsset(
      deps,
      { id: assetId, userId: line.userId, kind: 'audio' },
      take.wavPath,
      ctx.signal,
    );
    if (ctx.signal.aborted) throw new Error('Скасовано');
    const lang = languageInfo(line.language);
    await deps.db.transaction(async (tx) => {
      await tx.insert(assets).values({
        id: assetId,
        userId: line.userId,
        kind: 'audio',
        source: 'generated',
        status: 'ready',
        storageKey: key,
        mime: 'audio/wav',
        sizeBytes: take.bytes.length,
        durationMs: take.durationMs,
        title: `${take.projectTitle} — озвучка (${lang.name.toLowerCase()})`,
        tags: normalizeTags([line.language, 'озвучка', take.projectTitle]),
        language: line.language,
        generationId: take.generationId,
        ...sound,
      });
      const [t] = await tx
        .insert(transcripts)
        .values({
          userId: line.userId,
          assetId,
          language: line.language,
          source: 'tts',
          text: take.text,
          words: take.words,
          timing: take.timing,
        })
        .returning({ id: transcripts.id });
      await tx
        .update(voiceLines)
        .set({
          voice: take.voice,
          voicedHash: voicedHash(take.text, take.voice),
          audioAssetId: assetId,
          transcriptId: t!.id,
          durationMs: take.durationMs,
          status: 'ready',
          error: null,
          updatedAt: new Date(),
        })
        .where(and(eq(voiceLines.id, line.id), eq(voiceLines.jobId, ctx.jobId)));
    });
  } catch (e) {
    // об'єкт ще не належить asset
    await deps.storage.delete(key).catch(() => {});
    throw e;
  }
  return assetId;
}

/**
 * voice.synthesize: TTS → asset `audio` (ready) → мітки слів → transcripts → рядок `ready`.
 * Текст і голос беруться на старті: `voiced_hash` рахується від них, тож зміна під час задачі лишає рядок застарілим.
 * Ідемпотентна: якщо `voiced_hash` збігається й asset `ready` — нічого не генерує.
 */
export function synthesizeJob(deps: AppDeps): JobDef<{ lineId: string }, { assetId: string | null }> {
  return {
    type: 'voice.synthesize',
    concurrency: 3,
    async handler({ lineId }, ctx) {
      if (ctx.signal.aborted) throw new DOMException('Скасовано', 'AbortError');
      // атомарно забираємо рядок: його задача в черзі, або рядок вільний (повтор задачі);
      // рядок «в роботі» іншої задачі чи в черзі для іншої — не наш
      const [line] = await deps.db
        .update(voiceLines)
        .set({ status: 'running', jobId: ctx.jobId, error: null, updatedAt: new Date() })
        .where(
          and(
            eq(voiceLines.id, lineId),
            eq(voiceLines.userId, ctx.userId),
            or(
              and(eq(voiceLines.status, 'queued'), or(isNull(voiceLines.jobId), eq(voiceLines.jobId, ctx.jobId))),
              inArray(voiceLines.status, ['empty', 'failed', 'ready']),
            ),
          ),
        )
        .returning();
      if (!line) return { assetId: null };
      const setLine = (patch: Partial<typeof voiceLines.$inferInsert>) =>
        deps.db
          .update(voiceLines)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(voiceLines.id, lineId), eq(voiceLines.jobId, ctx.jobId)));
      const [p] = await deps.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, line.projectId), eq(projects.userId, line.userId)));
      if (!p) return { assetId: null };

      // знімок на старті задачі (текст — з рядка в момент захоплення)
      const text = line.text;
      const voice: VoiceChoice | null = await voiceForLanguage(deps, line.userId, p, line.language);
      if (!text.trim()) {
        await setLine({ status: 'empty' });
        return { assetId: null };
      }
      if (!voice) {
        const error = `Не вибрано голос для мови «${languageInfo(line.language).name}»`;
        await setLine({ status: 'failed', error });
        throw new Error(error);
      }
      const hash = voicedHash(text, voice);
      if (line.voicedHash === hash && line.audioAssetId) {
        const [a] = await deps.db
          .select({ status: assets.status })
          .from(assets)
          .where(eq(assets.id, line.audioAssetId));
        if (a?.status === 'ready') {
          await setLine({ status: 'ready' });
          return { assetId: line.audioAssetId };
        }
      }

      const dir = await mkdtemp(join(tmpdir(), 'vf-tts-'));
      let genId: string | null = null;
      try {
        const entry = (await deps.ai.catalog(line.userId)).find((e) => e.ref === voice.model && e.capability === 'tts');
        const tts = await deps.ai.tts(line.userId, voice.model);
        genId = await startGeneration(deps, {
          userId: line.userId,
          capability: 'tts',
          ref: voice.model,
          prompt: text,
          params: { lineId, language: line.language, voiceId: voice.voiceId, instructions: voice.instructions ?? null },
          jobId: ctx.jobId,
        });
        await ctx.progress(10, 'Озвучую');
        const { audio, words: ttsWords } = await tts.synthesize({
          text,
          voiceId: voice.voiceId,
          language: line.language,
          instructions: voice.instructions,
          signal: ctx.signal,
        });
        const wavPath = join(dir, 'voice.wav');
        await writeFile(wavPath, audio.bytes);
        const meta = await probe(deps.media, wavPath, { signal: ctx.signal });
        const durationMs = meta.durationMs ?? audio.durationMs ?? 0;

        await ctx.progress(50, 'Мітки слів');
        const { words, timing } = await wordTimings(deps, {
          userId: line.userId,
          jobId: ctx.jobId,
          text,
          language: line.language,
          wavPath,
          bytes: audio.bytes,
          durationMs,
          ttsWords,
          signal: ctx.signal,
        });

        await ctx.progress(80, 'Зберігаю');
        const gid = genId;
        const assetId = await saveLineTake(deps, ctx, line, {
          bytes: audio.bytes,
          wavPath,
          durationMs,
          words,
          timing,
          voice,
          text,
          projectTitle: p.title,
          generationId: gid,
        });
        await finishGeneration(deps, gid, {
          status: 'done',
          entry,
          usage: { durationSec: durationMs / 1000 },
          assetIds: [assetId],
        });
        await ctx.progress(100, 'Готово');
        return { assetId };
      } catch (e) {
        // скасування чи зупинка сервера: рядок відновлює подія скасування (або відновлення після рестарту)
        if (isCancelled(e, ctx.signal)) {
          if (genId) await finishGeneration(deps, genId, { status: 'cancelled' });
          throw e;
        }
        const message = (e as Error).message;
        if (genId) await finishGeneration(deps, genId, { status: 'failed', error: message });
        await setLine({ status: 'failed', error: message });
        throw e;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Скасований `voice.synthesize`: рядок повертається до стану без задачі — `ready`, якщо є попередня озвучка
 * (стан «застарілий» обчислюється з хешів), інакше `empty`. Лише якщо рядок досі належить цій задачі.
 */
export async function releaseCancelledLines(deps: AppDeps, lineIds: string[], jobId?: string): Promise<void> {
  if (!lineIds.length) return;
  await deps.db
    .update(voiceLines)
    .set({
      status: sql`case when ${voiceLines.audioAssetId} is not null and ${voiceLines.voicedHash} is not null then 'ready' else 'empty' end`,
      error: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(voiceLines.id, lineIds),
        inArray(voiceLines.status, ['queued', 'running']),
        jobId ? eq(voiceLines.jobId, jobId) : undefined,
      ),
    );
}

/**
 * Скасований `voice.synthesizeBatch`: усі рядки, що досі належать задачі й не дійшли до `ready`, — як у
 * `releaseCancelledLines` (рядки, вже записані `ready`, і рядки, передані окремим `voice.synthesize`, не чіпаються).
 */
export async function releaseJobLines(deps: AppDeps, jobId: string): Promise<void> {
  await deps.db
    .update(voiceLines)
    .set({
      status: sql`case when ${voiceLines.audioAssetId} is not null and ${voiceLines.voicedHash} is not null then 'ready' else 'empty' end`,
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(voiceLines.jobId, jobId), inArray(voiceLines.status, ['queued', 'running'])));
}

/** Скасована задача озвучки звільняє свої рядки (обидві задачі — ідемпотентно). */
export async function releaseForCancelledJob(deps: AppDeps, e: JobEvent): Promise<void> {
  if (e.status !== 'cancelled') return;
  if (e.type === 'voice.synthesize' && e.subject.lineId && isUuid(e.subject.lineId))
    await releaseCancelledLines(deps, [e.subject.lineId], e.jobId);
  if (e.type === 'voice.synthesizeBatch') await releaseJobLines(deps, e.jobId);
}

/** Слухач подій черги: скасований `voice.synthesize` (у черзі чи в роботі) звільняє свій рядок, пакетна — свої. */
export const releaseOnCancel =
  (deps: AppDeps) =>
  (e: JobEvent): void => {
    void releaseForCancelledJob(deps, e).catch(() => {});
  };
