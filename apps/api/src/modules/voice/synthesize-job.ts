import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { alignWords, estimateWords } from '@vf/captions';
import { assets, projects, transcripts, voiceLines } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { probe, speechIntervals } from '@vf/media';
import { assetKeys, languageInfo, normalizeTags, type JobEvent, type VoiceChoice, type Word } from '@vf/shared';
import type { AppDeps } from '../../app';
import { analyzeAsset } from '../assets/analyze-job';
import { finishGeneration, isCancelled, startGeneration } from './job-utils';
import { STT_MODEL, voiceForLanguage } from './service';
import { voicedHash } from './stale';

type Timing = 'aligned' | 'estimated';

/**
 * Мітки слів (4.1): слова від TTS, якщо є; інакше whisper-1 по згенерованому аудіо + `alignWords`;
 * без whisper — `estimateWords` за інтервалами мовлення (`timing: 'estimated'`).
 */
async function wordTimings(
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
): Promise<{ words: Word[]; timing: Timing }> {
  if (req.ttsWords?.length) return { words: req.ttsWords, timing: 'aligned' };
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
      if (r.words?.length) return { words: alignWords(req.text, r.words), timing: 'aligned' };
    } catch (e) {
      await finishGeneration(
        deps,
        genId,
        isCancelled(e, req.signal) ? { status: 'cancelled' } : { status: 'failed', error: (e as Error).message },
      );
      throw e;
    }
  }
  let speech: { startMs: number; endMs: number }[] = [];
  try {
    speech = await speechIntervals(deps.media, req.wavPath, { signal: req.signal });
  } catch (e) {
    // файл без аудіопотоку чи нечитабельний — слова рівномірно на всю тривалість
    if (isCancelled(e, req.signal)) throw e;
  }
  return { words: estimateWords(req.text, req.durationMs, speech), timing: 'estimated' };
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
      const [line] = await deps.db
        .select()
        .from(voiceLines)
        .where(and(eq(voiceLines.id, lineId), eq(voiceLines.userId, ctx.userId)));
      if (!line) return { assetId: null };
      const [p] = await deps.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, line.projectId), eq(projects.userId, line.userId)));
      if (!p) return { assetId: null };
      const setLine = (patch: Partial<typeof voiceLines.$inferInsert>) =>
        deps.db
          .update(voiceLines)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(voiceLines.id, lineId));

      // знімок на старті задачі
      const text = line.text;
      const voice: VoiceChoice | null = await voiceForLanguage(deps, line.userId, p, line.language);
      if (!text.trim()) {
        await setLine({ status: 'empty', error: null });
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
          await setLine({ status: 'ready', error: null });
          return { assetId: line.audioAssetId };
        }
      }

      await setLine({ status: 'running', error: null });
      const dir = await mkdtemp(join(tmpdir(), 'vf-tts-'));
      let genId: string | null = null;
      let uploadedKey: string | null = null;
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
        const assetId = randomUUID();
        const key = assetKeys.original(line.userId, assetId, 'wav');
        await deps.storage.put(key, audio.bytes, { contentType: 'audio/wav' });
        uploadedKey = key;
        const sound = await analyzeAsset(
          deps,
          { id: assetId, userId: line.userId, kind: 'audio' },
          wavPath,
          ctx.signal,
        );
        if (ctx.signal.aborted) throw new Error('Скасовано');
        const lang = languageInfo(line.language);
        const gid = genId;
        await deps.db.transaction(async (tx) => {
          await tx.insert(assets).values({
            id: assetId,
            userId: line.userId,
            kind: 'audio',
            source: 'generated',
            status: 'ready',
            storageKey: key,
            mime: 'audio/wav',
            sizeBytes: audio.bytes.length,
            durationMs,
            title: `${p.title} — озвучка (${lang.name.toLowerCase()})`,
            tags: normalizeTags([line.language, 'озвучка', p.title]),
            language: line.language,
            generationId: gid,
            ...sound,
          });
          const [t] = await tx
            .insert(transcripts)
            .values({ userId: line.userId, assetId, language: line.language, source: 'tts', text, words, timing })
            .returning({ id: transcripts.id });
          await tx
            .update(voiceLines)
            .set({
              voice,
              voicedHash: hash,
              audioAssetId: assetId,
              transcriptId: t!.id,
              durationMs,
              status: 'ready',
              error: null,
              updatedAt: new Date(),
            })
            .where(eq(voiceLines.id, lineId));
        });
        uploadedKey = null; // об'єкт тепер належить asset
        await finishGeneration(deps, gid, {
          status: 'done',
          entry,
          usage: { durationSec: durationMs / 1000 },
          assetIds: [assetId],
        });
        await ctx.progress(100, 'Готово');
        return { assetId };
      } catch (e) {
        if (uploadedKey) await deps.storage.delete(uploadedKey).catch(() => {});
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

/** Слухач подій черги: скасований `voice.synthesize` (у черзі чи в роботі) звільняє свій рядок. */
export const releaseOnCancel =
  (deps: AppDeps) =>
  (e: JobEvent): void => {
    if (e.type !== 'voice.synthesize' || e.status !== 'cancelled' || !e.subject.lineId) return;
    void releaseCancelledLines(deps, [e.subject.lineId], e.jobId).catch(() => {});
  };
