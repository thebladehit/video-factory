import { and, eq } from 'drizzle-orm';
import { buildTranslatePrompt, translateSchema } from '@vf/ai';
import { projects, voiceLines } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { normalizeDoc } from '@vf/shared';
import type { AppDeps } from '../../app';
import { finishGeneration, isCancelled, startGeneration, textModel } from './job-utils';
import { MAX_LINE_CHARS, clearFailure } from './service';
import { textHash } from './stale';

/** Сегментів в одному запиті; довші проєкти — порціями з попереднім контекстом */
export const TRANSLATE_CHUNK = 60;
export const TOO_LONG = `Переклад довший за ${MAX_LINE_CHARS} символів`;
/** Скільки вже перекладених фраз передати як контекст наступній порції */
const CONTEXT_LINES = 10;

/**
 * voice.translate: базові тексти → `generateObject` (усі сегменти одним запитом, порціями по 60) →
 * рядки мови `translated` з `source_hash` базового тексту, який перекладено.
 */
export function translateJob(
  deps: AppDeps,
): JobDef<{ projectId: string; language: string; segmentIds?: string[] }, { translated: number }> {
  return {
    type: 'voice.translate',
    concurrency: 2,
    async handler({ projectId, language, segmentIds }, ctx) {
      const [p] = await deps.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, ctx.userId)));
      if (!p || language === p.baseLanguage) return { translated: 0 };
      const wanted = segmentIds ? new Set(segmentIds) : null;
      const segments = (normalizeDoc(p.timeline).segments ?? []).filter((s) => !wanted || wanted.has(s.id));
      const base = new Map(
        (
          await deps.db
            .select({ segmentId: voiceLines.segmentId, text: voiceLines.text })
            .from(voiceLines)
            .where(and(eq(voiceLines.projectId, p.id), eq(voiceLines.language, p.baseLanguage)))
        ).map((l) => [l.segmentId, l.text]),
      );
      // «Перекласти все» (без segmentIds) не перезаписує ручні тексти мови; окремий сегмент — перекладається явно
      const manual = wanted
        ? new Set<string>()
        : new Set(
            (
              await deps.db
                .select({ segmentId: voiceLines.segmentId, text: voiceLines.text })
                .from(voiceLines)
                .where(
                  and(
                    eq(voiceLines.projectId, p.id),
                    eq(voiceLines.language, language),
                    eq(voiceLines.textOrigin, 'manual'),
                  ),
                )
            )
              .filter((l) => l.text.trim())
              .map((l) => l.segmentId),
          );
      // знімок базових текстів на старті: source_hash — хеш саме перекладеного тексту
      const items = segments
        .filter((s) => !manual.has(s.id))
        .map((s) => ({ id: s.id, text: base.get(s.id) ?? '' }))
        .filter((i) => i.text.trim());
      if (!items.length) return { translated: 0 };

      const entry = await textModel(deps, p.userId);
      const genId = await startGeneration(deps, {
        userId: p.userId,
        capability: 'text',
        ref: entry.ref,
        prompt: `translate ${p.baseLanguage} → ${language}`,
        params: { projectId, language, segments: items.length },
        jobId: ctx.jobId,
      });
      const usage = { inputTokens: 0, outputTokens: 0 };
      let translated = 0;
      try {
        const gen = await deps.ai.text(p.userId, entry.ref);
        let context: string[] = [];
        for (let i = 0; i < items.length; i += TRANSLATE_CHUNK) {
          const chunk = items.slice(i, i + TRANSLATE_CHUNK);
          await ctx.progress(5 + (90 * i) / items.length, 'Перекладаю');
          const { system, prompt } = buildTranslatePrompt({
            from: p.baseLanguage,
            to: language,
            items: chunk,
            context,
          });
          const r = await gen.generateObject(translateSchema, {
            system,
            prompt,
            signal: ctx.signal,
            onUsage: (u) => {
              usage.inputTokens += u.inputTokens;
              usage.outputTokens += u.outputTokens;
            },
          });
          const byId = new Map(r.items.map((x) => [x.id, x.text.trim()]));
          const done: string[] = [];
          for (const item of chunk) {
            const text = byId.get(item.id);
            if (!text) continue;
            if (text.length > MAX_LINE_CHARS) {
              // рядок не озвучити (ліміт TTS) — помилка лише цього рядка, наявний текст лишається
              const failed = { status: 'failed' as const, error: TOO_LONG, updatedAt: new Date() };
              await deps.db
                .insert(voiceLines)
                .values({ userId: p.userId, projectId: p.id, segmentId: item.id, language, text: '', ...failed })
                .onConflictDoUpdate({
                  target: [voiceLines.projectId, voiceLines.segmentId, voiceLines.language],
                  set: failed,
                });
              continue;
            }
            const patch = {
              text,
              textOrigin: 'translated' as const,
              sourceHash: textHash(item.text),
              updatedAt: new Date(),
            };
            await deps.db
              .insert(voiceLines)
              .values({ userId: p.userId, projectId: p.id, segmentId: item.id, language, ...patch })
              .onConflictDoUpdate({
                target: [voiceLines.projectId, voiceLines.segmentId, voiceLines.language],
                set: { ...patch, ...clearFailure },
              });
            done.push(text);
            translated++;
          }
          context = [...context, ...done].slice(-CONTEXT_LINES);
        }
        await finishGeneration(deps, genId, { status: 'done', entry, usage });
        await ctx.progress(100, 'Готово');
        return { translated };
      } catch (e) {
        await finishGeneration(
          deps,
          genId,
          isCancelled(e, ctx.signal) ? { status: 'cancelled' } : { status: 'failed', error: (e as Error).message },
        );
        throw e;
      }
    },
  };
}
