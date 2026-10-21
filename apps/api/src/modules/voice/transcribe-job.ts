import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SttSegment } from '@vf/ai';
import { assets, projects, voiceLines } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { probe, run } from '@vf/media';
import { compileAudioOnly, type SourceInfo } from '@vf/render';
import { AppError, LANGUAGES, normalizeDoc } from '@vf/shared';
import { segmentsFromSpeech } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { download, finishGeneration, isCancelled, startGeneration } from './job-utils';
import { NO_SOUND, originalAssetIds, sttModel } from './service';

/** Довше — частинами */
export const CHUNK_THRESHOLD_SEC = 90 * 60;
export const CHUNK_SEC = 60 * 60;
export const CHUNK_OVERLAP_SEC = 5;

/** Частини розпізнавання: до 90 хв — один шматок; довше — по 60 хв з перекриттям 5 с. */
export function chunkRanges(durationSec: number): { start: number; end: number }[] {
  if (durationSec <= CHUNK_THRESHOLD_SEC) return [{ start: 0, end: durationSec }];
  const out: { start: number; end: number }[] = [];
  for (let start = 0; ; start = out.at(-1)!.end - CHUNK_OVERLAP_SEC) {
    const end = Math.min(start + CHUNK_SEC, durationSec);
    out.push({ start, end });
    if (end >= durationSec) return out;
  }
}

/**
 * Склеювання частин (час уже абсолютний): у зоні перекриття межа — її середина;
 * фраза належить частині, у межах якої вона починається.
 */
export function stitchParts(parts: { start: number; end: number; segments: SttSegment[] }[]): SttSegment[] {
  return parts.flatMap((part, k) => {
    const from = k === 0 ? -Infinity : (parts[k - 1]!.end + part.start) / 2;
    const to = k === parts.length - 1 ? Infinity : (part.end + parts[k + 1]!.start) / 2;
    return part.segments.filter((s) => s.start >= from && s.start < to);
  });
}

/** Мітки STT ненадійні (особливо Gemini): без зворотних і нескінченних, у межах [0, duration], за порядком. */
export function sanitizeSegments(segments: SttSegment[], durationSec: number): SttSegment[] {
  return segments
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start && s.text.trim())
    .map((s) => ({
      start: Math.min(Math.max(0, s.start), durationSec),
      end: Math.min(Math.max(0, s.end), durationSec),
      text: s.text.trim(),
    }))
    .filter((s) => s.start < durationSec)
    .sort((a, b) => a.start - b.start);
}

/** Англійські назви мов (whisper повертає `english`) */
const LANGUAGE_NAMES: Record<string, string> = {
  ukrainian: 'uk',
  english: 'en',
  spanish: 'es',
  german: 'de',
  french: 'fr',
  italian: 'it',
  portuguese: 'pt',
  polish: 'pl',
  dutch: 'nl',
  czech: 'cs',
  romanian: 'ro',
  turkish: 'tr',
  swedish: 'sv',
  russian: 'ru',
  kazakh: 'kk',
};

/** Мова від STT (код, BCP-47 з регіоном або англійська назва) → код із конфігу мов; null — невідома. */
export function languageCode(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  const code = LANGUAGE_NAMES[v] ?? v.split(/[-_]/)[0]!;
  return LANGUAGES.some((l) => l.code === code) ? code : null;
}

/**
 * voice.transcribe: мікс ролі `original` (моно 16 кГц Opus) → STT (частинами для > 90 хв) → `segmentsFromSpeech` →
 * сегменти в документі (версія +1) і рядки базової мови `stt`. Мова — задана, визначена STT або базова.
 */
export function transcribeJob(deps: AppDeps): JobDef<{ projectId: string; language?: string }, { segments: number }> {
  return {
    type: 'voice.transcribe',
    concurrency: 2,
    async handler({ projectId, language }, ctx) {
      const [p] = await deps.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)));
      if (!p) return { segments: 0 };
      const doc = normalizeDoc(p.timeline);
      const ids = originalAssetIds(doc);
      const rows = ids.length
        ? await deps.db
            .select()
            .from(assets)
            .where(and(eq(assets.userId, p.userId), inArray(assets.id, ids)))
        : [];
      if (!rows.length) throw new AppError('VALIDATION', NO_SOUND);

      const dir = await mkdtemp(join(tmpdir(), 'vf-stt-'));
      let genId: string | null = null;
      try {
        await ctx.progress(2, 'Готую звук');
        const sources = new Map<string, SourceInfo>();
        for (const a of rows) {
          const ext = a.storageKey.slice(a.storageKey.lastIndexOf('.') + 1);
          const path = join(dir, `${a.id}.${ext}`);
          await download(deps, a.storageKey, path);
          const meta = await probe(deps.media, path, { signal: ctx.signal });
          sources.set(a.id, {
            path,
            kind: a.kind,
            width: meta.width ?? undefined,
            height: meta.height ?? undefined,
            hasAudio: meta.hasAudio,
            audioChannels: meta.audioChannels,
          });
        }
        if (![...sources.values()].some((s) => s.hasAudio)) throw new AppError('VALIDATION', NO_SOUND);

        const mix = join(dir, 'original.webm');
        const compiled = compileAudioOnly({
          doc,
          sources,
          roles: ['original'],
          outPath: mix,
          filterScriptPath: join(dir, 'graph.txt'),
        });
        await writeFile(join(dir, 'graph.txt'), compiled.filterScript);
        const T = compiled.durationSec;
        await run(deps.media.ffmpegPath, compiled.args, {
          signal: ctx.signal,
          timeoutMs: Math.max(600_000, T * 1000),
        });

        const entry = await sttModel(deps, p.userId);
        genId = await startGeneration(deps, {
          userId: p.userId,
          capability: 'stt',
          ref: entry.ref,
          prompt: `transcribe ${p.title}`,
          params: { projectId, language: language ?? null, purpose: 'transcribe' },
          jobId: ctx.jobId,
        });
        const stt = await deps.ai.stt(p.userId, entry.ref);
        const ranges = chunkRanges(T);
        const parts: { start: number; end: number; segments: SttSegment[] }[] = [];
        let detected: string | undefined;
        for (const [k, r] of ranges.entries()) {
          await ctx.progress(10 + (80 * k) / ranges.length, 'Розпізнаю мовлення');
          let path = mix;
          if (ranges.length > 1) {
            path = join(dir, `part-${k}.webm`);
            await run(
              deps.media.ffmpegPath,
              [
                '-v',
                'error',
                '-y',
                '-ss',
                String(r.start),
                '-t',
                String(r.end - r.start),
                '-i',
                mix,
                '-c',
                'copy',
                path,
              ],
              { signal: ctx.signal, timeoutMs: 600_000 },
            );
          }
          const res = await stt.transcribe({
            audio: new Uint8Array(await readFile(path)),
            mime: 'audio/webm',
            language,
            signal: ctx.signal,
          });
          detected ??= res.language;
          parts.push({
            ...r,
            segments: res.segments.map((s) => ({ ...s, start: s.start + r.start, end: s.end + r.start })),
          });
        }

        const speech = sanitizeSegments(stitchParts(parts), T);
        const { segments, texts } = segmentsFromSpeech(speech, T, doc.fps);
        if (!Object.keys(texts).length) throw new Error('Мовлення не розпізнано');
        let lang = language ?? p.baseLanguage;
        if (!language && detected) {
          const code = languageCode(detected);
          // не зберігаємо чужу мову під кодом базової
          if (!code)
            throw new AppError('VALIDATION', `Мова «${detected}» не підтримується — виберіть мову вручну`, {
              detected,
            });
          lang = code;
        }

        await ctx.progress(95, 'Зберігаю сегменти');
        await deps.db.transaction(async (tx) => {
          // документ міг змінитися, поки йшло розпізнавання: замінюємо лише сегменти в актуальній версії
          const [cur] = await tx.select().from(projects).where(eq(projects.id, p.id)).for('update');
          if (!cur) throw new AppError('NOT_FOUND', 'Проєкт видалено');
          await tx
            .update(projects)
            .set({
              timeline: { ...normalizeDoc(cur.timeline), segments },
              timelineVersion: sql`${projects.timelineVersion} + 1`,
              baseLanguage: lang,
              languages: cur.languages.includes(lang) ? cur.languages : [lang, ...cur.languages],
              updatedAt: new Date(),
            })
            .where(eq(projects.id, p.id));
          const lines = Object.entries(texts).map(([segmentId, text]) => ({
            userId: p.userId,
            projectId: p.id,
            segmentId,
            language: lang,
            text,
            textOrigin: 'stt' as const,
          }));
          if (lines.length) await tx.insert(voiceLines).values(lines);
        });
        await finishGeneration(deps, genId, { status: 'done', entry, usage: { durationSec: T } });
        await ctx.progress(100, 'Готово');
        return { segments: segments.length };
      } catch (e) {
        if (genId)
          await finishGeneration(
            deps,
            genId,
            isCancelled(e, ctx.signal) ? { status: 'cancelled' } : { status: 'failed', error: (e as Error).message },
          );
        throw e;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
