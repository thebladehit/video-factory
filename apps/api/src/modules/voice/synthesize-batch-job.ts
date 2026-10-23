import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { TTS_MAX_CHARS } from '@vf/ai';
import { CHUNK_JOIN, alignWordsDetailed, chunkLines, splitTake, tokenize } from '@vf/captions';
import { assets, projects, voiceLines } from '@vf/db';
import type { JobContext, JobDef } from '@vf/jobs';
import { cutAudio, probe, speechIntervals } from '@vf/media';
import { languageInfo, normalizeDoc, type VoiceChoice } from '@vf/shared';
import type { AppDeps } from '../../app';
import { finishGeneration, isCancelled, startGeneration } from './job-utils';
import { voiceForLanguage } from './service';
import { voicedHash } from './stale';
import { releaseJobLines, saveLineTake, wordTimings } from './synthesize-job';

export interface SynthesizeBatchPayload {
  projectId: string;
  language: string;
  lineIds: string[];
}

type LineRow = typeof voiceLines.$inferSelect;

/**
 * voice.synthesizeBatch (спека 4.3): рядки мови озвучуються шматками (≤ TTS_MAX_CHARS, межі — лише між рядками,
 * рядки через порожній рядок) — один запит TTS і одна генерація на шматок; дубль ріжеться на рядки по паузах
 * (`splitTake`), кожен рядок → власний asset, транскрипт і `ready` з тим самим `voiced_hash`, що дав би
 * `voice.synthesize`. Рядки з ненадійною межею → окремі `voice.synthesize`; помилка TTS шматка → його рядки `failed`.
 * Скасування: рядки задачі, що не встигли стати `ready`, повертаються до стану без задачі.
 */
export function synthesizeBatchJob(
  deps: AppDeps,
): JobDef<SynthesizeBatchPayload, { ready: number; fallback: number; failed: number }> {
  return {
    type: 'voice.synthesizeBatch',
    concurrency: 2,
    async handler({ projectId, language, lineIds }, ctx) {
      const result = { ready: 0, fallback: 0, failed: 0 };
      if (ctx.signal.aborted) throw new DOMException('Скасовано', 'AbortError');
      if (!lineIds.length) return result;
      // атомарно, як voice.synthesize: рядок у черзі для цієї задачі (чи ще без id задачі) або вільний
      const claimed = await deps.db
        .update(voiceLines)
        .set({ status: 'running', jobId: ctx.jobId, error: null, updatedAt: new Date() })
        .where(
          and(
            inArray(voiceLines.id, lineIds),
            eq(voiceLines.userId, ctx.userId),
            eq(voiceLines.projectId, projectId),
            eq(voiceLines.language, language),
            or(
              and(eq(voiceLines.status, 'queued'), or(isNull(voiceLines.jobId), eq(voiceLines.jobId, ctx.jobId))),
              inArray(voiceLines.status, ['empty', 'failed', 'ready']),
            ),
          ),
        )
        .returning();
      if (!claimed.length) return result;
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      const setLines = (lines: string[], patch: Partial<typeof voiceLines.$inferInsert>) =>
        lines.length
          ? deps.db
              .update(voiceLines)
              .set({ ...patch, updatedAt: new Date() })
              .where(and(inArray(voiceLines.id, lines), eq(voiceLines.jobId, ctx.jobId)))
          : Promise.resolve();

      try {
        const [p] = await deps.db
          .select()
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)));
        if (!p) {
          await releaseJobLines(deps, ctx.jobId);
          return result;
        }
        // знімок на старті: тексти — з рядків у момент захоплення, голос — мови зараз
        const voice = await voiceForLanguage(deps, ctx.userId, p, language);
        const blank = claimed.filter((l) => !l.text.trim());
        await setLines(ids(blank), { status: 'empty' });
        let todo = claimed.filter((l) => l.text.trim());
        if (!voice) {
          const error = `Не вибрано голос для мови «${languageInfo(language).name}»`;
          await setLines(ids(todo), { status: 'failed', error });
          throw new Error(error);
        }

        // уже озвучено тим самим текстом і голосом (повтор задачі) — нічого не генеруємо
        const hash = (l: LineRow) => voicedHash(l.text, voice);
        const voiced = todo.filter((l) => l.voicedHash === hash(l) && l.audioAssetId);
        if (voiced.length) {
          const ready = new Set(
            ids(
              await deps.db
                .select({ id: assets.id })
                .from(assets)
                .where(
                  and(
                    inArray(
                      assets.id,
                      voiced.map((l) => l.audioAssetId!),
                    ),
                    eq(assets.status, 'ready'),
                  ),
                ),
            ),
          );
          const done = voiced.filter((l) => ready.has(l.audioAssetId!));
          await setLines(ids(done), { status: 'ready' });
          result.ready += done.length;
          todo = todo.filter((l) => !done.includes(l));
        }

        // порядок сегментів документа
        const order = new Map((normalizeDoc(p.timeline).segments ?? []).map((s, i) => [s.id, i]));
        todo.sort((a, b) => (order.get(a.segmentId) ?? Infinity) - (order.get(b.segmentId) ?? Infinity));
        const byId = new Map(todo.map((l) => [l.id, l]));
        const chunks = chunkLines(
          todo.map((l) => ({ id: l.id, text: l.text })),
          TTS_MAX_CHARS,
        );

        let firstError: string | null = null;
        for (const [i, chunk] of chunks.entries()) {
          await ctx.progress(Math.round((i / chunks.length) * 100), `Озвучую ${i + 1} з ${chunks.length}`);
          const lines = chunk.map((c) => byId.get(c.id)!);
          const r = await synthesizeChunk(deps, ctx, { lines, voice, language, projectTitle: p.title });
          result.ready += r.ready;
          result.fallback += r.fallback;
          result.failed += r.failed;
          if (r.error && !firstError) firstError = r.error;
        }
        await ctx.progress(100, 'Готово');
        // помилка шматка: його рядки failed, решта збережена — задача теж failed, щоб її було видно
        if (firstError) throw new Error(firstError);
        return result;
      } catch (e) {
        // скасування чи зупинка сервера: рядки, що не стали ready, відновлює подія скасування (`releaseJobLines`)
        // або відновлення після рестарту — як для voice.synthesize
        if (!isCancelled(e, ctx.signal))
          await deps.db
            .update(voiceLines)
            .set({ status: 'failed', error: (e as Error).message, updatedAt: new Date() })
            .where(and(eq(voiceLines.jobId, ctx.jobId), eq(voiceLines.status, 'running')));
        throw e;
      }
    },
  };
}

/** Один шматок: TTS → мітки слів → межі рядків → вирізки; рядки з ненадійною межею — окремими задачами. */
async function synthesizeChunk(
  deps: AppDeps,
  ctx: JobContext,
  c: { lines: LineRow[]; voice: VoiceChoice; language: string; projectTitle: string },
): Promise<{ ready: number; fallback: number; failed: number; error?: string }> {
  const { lines, voice, language } = c;
  const userId = ctx.userId;
  const lineIds = lines.map((l) => l.id);
  const text = lines.map((l) => l.text).join(CHUNK_JOIN);
  const dir = await mkdtemp(join(tmpdir(), 'vf-tts-batch-'));
  let genId: string | null = null;
  const saved: string[] = [];
  const out = { ready: 0, fallback: 0, failed: 0 };
  try {
    const entry = (await deps.ai.catalog(userId)).find((e) => e.ref === voice.model && e.capability === 'tts');
    const tts = await deps.ai.tts(userId, voice.model);
    genId = await startGeneration(deps, {
      userId,
      capability: 'tts',
      ref: voice.model,
      prompt: text,
      params: { lineIds, language, voiceId: voice.voiceId, instructions: voice.instructions ?? null },
      jobId: ctx.jobId,
    });
    const { audio, words: ttsWords } = await tts.synthesize({
      text,
      voiceId: voice.voiceId,
      language,
      instructions: voice.instructions,
      signal: ctx.signal,
    });
    const wavPath = join(dir, 'take.wav');
    await writeFile(wavPath, audio.bytes);
    const durationMs = (await probe(deps.media, wavPath, { signal: ctx.signal })).durationMs ?? audio.durationMs ?? 0;

    // слова TTS не збігаються з токенами тексту (пунктуація окремими словами) — вирівнюємо їх як STT
    const timings =
      ttsWords?.length && ttsWords.length !== tokenize(text).length
        ? { ...alignWordsDetailed(text, ttsWords), timing: 'aligned' as const }
        : await wordTimings(deps, {
            userId,
            jobId: ctx.jobId,
            text,
            language,
            wavPath,
            bytes: audio.bytes,
            durationMs,
            ttsWords,
            signal: ctx.signal,
          });
    let speech: { startMs: number; endMs: number }[] = [];
    try {
      speech = await speechIntervals(deps.media, wavPath, { signal: ctx.signal });
    } catch (e) {
      if (isCancelled(e, ctx.signal)) throw e;
    }
    const { lines: ranges } = splitTake({
      words: timings.words,
      matched: timings.matched,
      lineTexts: lines.map((l) => l.text),
      speech,
      durationMs,
    });

    for (const [i, line] of lines.entries()) {
      const range = ranges[i];
      if (!range) continue;
      const cutPath = join(dir, `line-${i}.wav`);
      await cutAudio(deps.media, wavPath, cutPath, range.startMs, range.endMs, { signal: ctx.signal });
      const bytes = new Uint8Array(await readFile(cutPath));
      const lineMs =
        (await probe(deps.media, cutPath, { signal: ctx.signal })).durationMs ?? range.endMs - range.startMs;
      saved.push(
        await saveLineTake(deps, ctx, line, {
          bytes,
          wavPath: cutPath,
          durationMs: lineMs,
          words: range.words.map((w) => ({ ...w, endMs: Math.min(w.endMs, lineMs) })),
          timing: timings.timing,
          voice,
          text: line.text,
          projectTitle: c.projectTitle,
          generationId: genId,
        }),
      );
      out.ready += 1;
    }
    // оплачено весь дубль шматка, навіть якщо частина рядків піде окремими задачами
    const gid = genId;
    genId = null; // далі генерацію вже не переписуємо (ні cancelled, ні failed)
    await finishGeneration(deps, gid, {
      status: 'done',
      entry,
      usage: { durationSec: durationMs / 1000 },
      assetIds: saved,
    });

    // ненадійна межа: рядок не ріжемо навмання — окремий voice.synthesize
    for (const [i, line] of lines.entries()) {
      if (ranges[i]) continue;
      if (await enqueueSingle(deps, ctx, line.id)) out.fallback += 1;
    }
    return out;
  } catch (e) {
    if (isCancelled(e, ctx.signal)) {
      if (genId) await finishGeneration(deps, genId, { status: 'cancelled' });
      throw e;
    }
    const message = (e as Error).message;
    if (genId) await finishGeneration(deps, genId, { status: 'failed', error: message });
    // рядки шматка, що ще не готові, — failed (уже збережені лишаються ready)
    const failed = await deps.db
      .update(voiceLines)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(and(inArray(voiceLines.id, lineIds), eq(voiceLines.jobId, ctx.jobId), eq(voiceLines.status, 'running')))
      .returning({ id: voiceLines.id });
    return { ...out, failed: failed.length, error: message };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Рядок пакетної задачі → окремий `voice.synthesize` за протоколом `enqueueSynthesize`: «в черзі» без задачі
 * (лише поки рядок належить цій пакетній задачі), задача, потім її id.
 */
async function enqueueSingle(deps: AppDeps, ctx: JobContext, lineId: string): Promise<boolean> {
  const [won] = await deps.db
    .update(voiceLines)
    .set({ status: 'queued', jobId: null, error: null, updatedAt: new Date() })
    .where(and(eq(voiceLines.id, lineId), eq(voiceLines.jobId, ctx.jobId), eq(voiceLines.status, 'running')))
    .returning({ id: voiceLines.id });
  if (!won) return false;
  let jobId: string;
  try {
    jobId = await deps.jobs.queue.enqueue('voice.synthesize', { lineId }, { userId: ctx.userId });
  } catch (e) {
    // рядок не має лишитися «в черзі» без задачі
    await deps.db
      .update(voiceLines)
      .set({ status: 'failed', error: (e as Error).message, updatedAt: new Date() })
      .where(and(eq(voiceLines.id, lineId), eq(voiceLines.status, 'queued'), isNull(voiceLines.jobId)));
    throw e;
  }
  await deps.db
    .update(voiceLines)
    .set({ jobId })
    .where(and(eq(voiceLines.id, lineId), eq(voiceLines.status, 'queued'), isNull(voiceLines.jobId)));
  return true;
}
