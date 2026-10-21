import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { assets, projects, renders } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { MediaToolError, probe } from '@vf/media';
import type { SourceInfo } from '@vf/render';
import { AppError, assetKeys, isAppError, normalizeDoc, type JobStatus } from '@vf/shared';
import { docDuration } from '@vf/timeline';
import type { AppDeps } from '../../app';

const TITLE_DATE = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Kyiv',
});

class RenderFailure extends Error {}

const deleted = (title: string) => new RenderFailure(`Файл «${title || 'без назви'}» видалено з бібліотеки`);

function userMessage(e: unknown): string {
  if (e instanceof RenderFailure) return e.message;
  if (e instanceof MediaToolError && e.reason === 'timeout') return 'Рендер перевищив ліміт часу';
  if (e instanceof MediaToolError && e.reason === 'exit') return `Помилка ffmpeg: ${e.message.slice(-600)}`;
  if (isAppError(e) && e.code === 'VALIDATION') return e.message;
  return (e as Error).message;
}

async function setStatus(deps: AppDeps, id: string, status: JobStatus, fields: { error?: string | null } = {}) {
  await deps.db
    .update(renders)
    .set({ status, ...fields, finishedAt: status === 'running' || status === 'queued' ? null : new Date() })
    .where(eq(renders.id, id));
}

/**
 * render: знімок таймлайну (+ ASS мови) → ffmpeg → MP4 у сховище → asset (id = id рендеру) → asset.process.
 * Ідемпотентна: якщо asset рендеру вже є, лише доводить стан до кінця.
 */
export function renderJob(
  deps: AppDeps,
  opts: { fontsDir?: string } = {},
): JobDef<{ renderId: string }, { assetId: string }> {
  return {
    type: 'render',
    concurrency: 1,
    async handler({ renderId }, ctx) {
      const [r] = await deps.db.select().from(renders).where(eq(renders.id, renderId));
      if (!r) return { assetId: renderId };
      const [existing] = await deps.db.select({ id: assets.id }).from(assets).where(eq(assets.id, renderId));
      if (existing) {
        await deps.db
          .update(renders)
          .set({ outputAssetId: renderId, status: 'done', error: null, finishedAt: new Date() })
          .where(eq(renders.id, renderId));
        return { assetId: renderId };
      }

      await setStatus(deps, renderId, 'running', { error: null });
      const dir = await mkdtemp(join(tmpdir(), `vf-render-${renderId.slice(0, 8)}-`));
      const key = assetKeys.original(r.userId, renderId, 'mp4');
      let uploaded = false;
      try {
        const doc = normalizeDoc(r.timelineSnapshot);
        const ids = [
          ...new Set(doc.tracks.flatMap((t) => (t.kind === 'captions' ? [] : t.clips.map((c) => c.assetId)))),
        ];
        const rows = ids.length
          ? await deps.db
              .select()
              .from(assets)
              .where(and(eq(assets.userId, r.userId), inArray(assets.id, ids)))
          : [];
        const byId = new Map(rows.map((a) => [a.id, a]));
        const gone = ids.find((id) => !byId.has(id));
        if (gone) throw deleted('');
        await ctx.progress(1, 'Завантажую файли');

        const sources = new Map<string, SourceInfo>();
        for (const a of rows) {
          const ext = a.storageKey.slice(a.storageKey.lastIndexOf('.') + 1);
          const path = join(dir, `${a.id}.${ext}`);
          const obj = await deps.storage.get(a.storageKey).catch((e) => {
            if (isAppError(e) && e.code === 'NOT_FOUND') throw deleted(a.title);
            throw e;
          });
          await pipeline(obj.body, createWriteStream(path));
          const meta = await probe(deps.media, path, { signal: ctx.signal });
          sources.set(a.id, {
            path,
            kind: a.kind,
            width: meta.width ?? a.width ?? undefined,
            height: meta.height ?? a.height ?? undefined,
            hasAudio: meta.hasAudio,
            audioChannels: meta.audioChannels,
          });
        }

        const T = docDuration(doc);
        await deps.renderer.render(
          {
            doc,
            preset: r.preset,
            sources,
            language: r.language,
            // кожен рендер — у своїй теці: subs.ass пишеться поруч із graph.txt
            ...(r.subtitles ? { subtitles: r.subtitles, fontsDir: opts.fontsDir } : {}),
            filterScriptPath: join(dir, 'graph.txt'),
            outPath: join(dir, 'out.mp4'),
          },
          {
            signal: ctx.signal,
            timeoutMs: Math.max(600_000, 5 * T * 1000),
            onProgress: (pct) => void ctx.progress(Math.min(95, pct), 'Рендер').catch(() => {}),
          },
        );

        // файл видалили, поки йшов ffmpeg: результат не публікуємо
        const still = new Set(
          (await deps.db.select({ id: assets.id }).from(assets).where(inArray(assets.id, ids))).map((a) => a.id),
        );
        const removed = rows.find((a) => !still.has(a.id));
        if (removed) throw deleted(removed.title);

        await ctx.progress(96, 'Зберігаю');
        const out = join(dir, 'out.mp4');
        await deps.storage.put(key, createReadStream(out), { contentType: 'video/mp4' });
        uploaded = true;
        if (ctx.signal.aborted) throw new MediaToolError('Скасовано', 'aborted');
        const [project] = await deps.db
          .select({ title: projects.title })
          .from(projects)
          .where(eq(projects.id, r.projectId));
        if (!project) throw new AppError('NOT_FOUND', 'Проєкт видалено');
        await deps.db
          .insert(assets)
          .values({
            id: renderId,
            userId: r.userId,
            kind: 'video',
            source: 'rendered',
            status: 'processing',
            storageKey: key,
            mime: 'video/mp4',
            sizeBytes: (await stat(out)).size,
            language: r.language,
            title: `${project.title}${r.language ? ` (${r.language})` : ''} — ${TITLE_DATE.format(new Date())}`,
          })
          .onConflictDoNothing();
        uploaded = false; // об'єкт тепер належить asset
        await deps.db
          .update(renders)
          .set({ outputAssetId: renderId, status: 'done', error: null, finishedAt: new Date() })
          .where(eq(renders.id, renderId));
        await deps.jobs.queue.enqueue('asset.process', { assetId: renderId }, { userId: r.userId });
        await ctx.progress(100, 'Готово');
        return { assetId: renderId };
      } catch (e) {
        if (uploaded) await deps.storage.delete(key).catch(() => {});
        // скасування чи зупинка сервера: стан бере задача (див. listRenders)
        if (ctx.signal.aborted) throw e;
        const message = userMessage(e);
        await setStatus(deps, renderId, 'failed', { error: message });
        throw new Error(message, { cause: e });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
