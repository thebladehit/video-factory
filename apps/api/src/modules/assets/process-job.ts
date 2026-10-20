import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, eq } from 'drizzle-orm';
import { assets } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { MediaToolError, probe, thumbnail } from '@vf/media';
import { assetKeys, isAppError } from '@vf/shared';
import type { AppDeps } from '../../app';
import { analyzeAsset } from './analyze-job';
import type { AssetRow } from './service';

const KIND_LABEL = { image: 'фото', video: 'відео', audio: 'аудіо' } as const;

/** Теги після обробки (Task 11 підставляє справжню реалізацію). */
export type TagAfterProcess = (deps: AppDeps, asset: AssetRow) => Promise<void>;

/**
 * Помилка, яку бачить користувач у картці файлу; null — збій інфраструктури або скасування,
 * задача падає й підхоплюється «Повторити» / відновленням після рестарту.
 */
function userFacingError(e: unknown): string | null {
  if (isAppError(e) && e.code === 'VALIDATION') return e.message;
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'FFmpeg недоступний у контейнері API';
  if (e instanceof MediaToolError && e.reason !== 'aborted') return `Не вдалося створити мініатюру: ${e.message}`;
  return null;
}

/**
 * asset.process: ffprobe-метадані → мініатюра → звук (has_audio, піки) → ready, далі теги.
 * Ідемпотентна: працює лише з processing, фіксований ключ мініатюри, стан пишеться наприкінці.
 */
export function assetProcessJob(
  deps: AppDeps,
  tagAfterProcess: TagAfterProcess = async () => {},
): JobDef<{ assetId: string }, { assetId: string }> {
  return {
    type: 'asset.process',
    concurrency: 2,
    async handler({ assetId }, ctx) {
      const [row] = await deps.db.select().from(assets).where(eq(assets.id, assetId));
      if (!row || row.status !== 'processing') return { assetId };

      const fail = (error: string) =>
        deps.db
          .update(assets)
          .set({ status: 'failed', error })
          .where(and(eq(assets.id, assetId), eq(assets.status, 'processing')));

      const dir = await mkdtemp(join(tmpdir(), 'vf-asset-'));
      let thumbKey: string | null = null;
      try {
        const original = join(dir, 'original');
        const obj = await deps.storage.get(row.storageKey).catch(async (e) => {
          if (!isAppError(e) || e.code !== 'NOT_FOUND') throw e;
          // файл видалили (разом з рядком) — тихо виходимо; рядок є, а об'єкта нема — пояснюємо
          const [still] = await deps.db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId));
          if (still) await fail('Оригінал файлу не знайдено у сховищі');
          return null;
        });
        if (!obj) return { assetId };
        await pipeline(obj.body, createWriteStream(original));
        await ctx.progress(30, 'Читаю метадані');

        const meta = await probe(deps.media, original, { signal: ctx.signal });
        if (meta.kind !== row.kind) {
          await fail(
            `Тип файлу не збігається з розширенням: очікувалось ${KIND_LABEL[row.kind]}, отримано ${KIND_LABEL[meta.kind]}`,
          );
          return { assetId };
        }

        if (meta.kind !== 'audio') {
          await ctx.progress(60, 'Створюю мініатюру');
          const out = join(dir, 'thumb.webp');
          await thumbnail(deps.media, original, out, {
            kind: meta.kind,
            durationMs: meta.durationMs,
            signal: ctx.signal,
          });
          thumbKey = assetKeys.thumb(row.userId, row.id);
          await deps.storage.put(thumbKey, await readFile(out), { contentType: 'image/webp' });
        }

        await ctx.progress(75, 'Аналізую звук');
        const sound = await analyzeAsset(deps, row, original, ctx.signal);

        const [ready] = await deps.db
          .update(assets)
          .set({
            ...sound,
            status: 'ready',
            error: null,
            mime: meta.mime,
            width: meta.width ?? null,
            height: meta.height ?? null,
            durationMs: meta.durationMs ?? null,
            thumbKey,
          })
          .where(and(eq(assets.id, assetId), eq(assets.status, 'processing')))
          .returning();
        if (!ready) {
          // файл видалили під час обробки — прибираємо те, що встигли покласти
          if (thumbKey) await deps.storage.delete(thumbKey);
          if (sound.peaksKey) await deps.storage.delete(sound.peaksKey);
          return { assetId };
        }
        await ctx.progress(90, 'Теги');
        await tagAfterProcess(deps, ready);
        return { assetId };
      } catch (e) {
        const message = userFacingError(e);
        if (message === null) throw e; // БД/S3 — задачу можна повторити
        await fail(message);
        return { assetId };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
