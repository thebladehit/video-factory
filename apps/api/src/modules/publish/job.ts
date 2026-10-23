import { and, eq, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import { assets, jobs, projects, publications, renders, socialAccounts } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { AUTH_LOST_MESSAGE, NO_CHANNEL_MESSAGE, PublishError, QUOTA_MESSAGE, type UploadFile } from '@vf/publish';
import { PLATFORM_LABELS } from '@vf/shared';
import type { AppDeps } from '../../app';
import { accessTokenFor } from './accounts';

/** YouTube приймає publishAt лише з запасом від поточного часу */
const PUBLISH_AT_MIN_AHEAD_MS = 5 * 60_000;

class PublishFailure extends Error {}

/** Текст помилки публікації українською (те саме — в publications.error і jobs.error) */
export function publishErrorMessage(e: unknown): string {
  if (e instanceof PublishFailure) return e.message;
  if (e instanceof PublishError) {
    if (e.reason === 'quota') return QUOTA_MESSAGE;
    if (e.platformReason === 'youtubeSignupRequired') return NO_CHANNEL_MESSAGE;
    if (e.reason === 'auth') return AUTH_LOST_MESSAGE;
    return `Помилка YouTube: ${e.platformReason ?? e.message}`;
  }
  return `Помилка YouTube: ${e instanceof Error ? e.message : String(e)}`;
}

/** Рядок вільний для задачі jobId: без задачі, вже її, або попередня задача не жива */
const freeFor = (jobId: string) =>
  or(
    isNull(publications.jobId),
    eq(publications.jobId, jobId),
    notExists(
      sql`(select 1 from ${jobs} where ${jobs.id} = ${publications.jobId} and ${jobs.status} in ('queued', 'running'))`,
    ),
  );

/**
 * Ставить задачу `publish` для api-публікації в `scheduled`. Прив'язка — умовним UPDATE:
 * якщо рядок уже має живу задачу (гонка створення й тіку) або вийшов зі `scheduled`, нову задачу скасовуємо.
 */
export async function enqueuePublish(deps: AppDeps, pub: { id: string; userId: string }): Promise<string | null> {
  const jobId = await deps.jobs.queue.enqueue('publish', { publicationId: pub.id }, { userId: pub.userId });
  const [row] = await deps.db
    .update(publications)
    .set({ jobId, updatedAt: new Date() })
    .where(
      and(
        eq(publications.id, pub.id),
        // задача могла встигнути стартувати й сама зайняти рядок
        or(and(eq(publications.status, 'scheduled'), freeFor(jobId)), eq(publications.jobId, jobId)),
      ),
    )
    .returning({ id: publications.id });
  if (row) return jobId;
  await deps.jobs.queue.cancel(jobId);
  return null;
}

/**
 * publish: resumable-завантаження через Publisher → `processing` (готовність перевіряє тік).
 * Ідемпотентна: стартує лише для рядка `scheduled`/`uploading`, вільного для цієї задачі;
 * продовжує збережену `upload_session` (рестарт, «Повторити»).
 */
export function publishJob(deps: AppDeps): JobDef<{ publicationId: string }, void> {
  return {
    type: 'publish',
    concurrency: 1,
    async handler({ publicationId }, ctx) {
      const mine = and(eq(publications.id, publicationId), eq(publications.jobId, ctx.jobId));
      const [pub] = await deps.db
        .update(publications)
        .set({ status: 'uploading', jobId: ctx.jobId, error: null, updatedAt: new Date() })
        .where(
          and(
            eq(publications.id, publicationId),
            eq(publications.method, 'api'),
            or(
              and(inArray(publications.status, ['scheduled', 'uploading']), eq(publications.jobId, ctx.jobId)),
              and(eq(publications.status, 'scheduled'), freeFor(ctx.jobId)),
            ),
          ),
        )
        .returning();
      // скасовано, вже завантажено чи рядок зайняла інша задача — нічого не робимо
      if (!pub) return;
      // відео вже на платформі: лише повертаємо до опитування обробки, без другого завантаження
      if (pub.platformPostId) {
        const now = new Date();
        await deps.db
          .update(publications)
          .set({ status: 'processing', processingSince: now, error: null, updatedAt: now })
          .where(and(mine, eq(publications.status, 'uploading')));
        return;
      }

      try {
        const publisher = deps.publish.publishers[pub.platform];
        if (!publisher) {
          throw new PublishFailure(`Публікація через API на ${PLATFORM_LABELS[pub.platform]} не налаштована`);
        }
        const [src] = await deps.db
          .select({ storageKey: assets.storageKey, sizeBytes: assets.sizeBytes, format: projects.format })
          .from(renders)
          .innerJoin(assets, eq(assets.id, renders.outputAssetId))
          .innerJoin(projects, eq(projects.id, renders.projectId))
          .where(eq(renders.id, pub.renderId));
        if (!src) throw new PublishFailure('Файл відео не знайдено');
        const size = src.sizeBytes ?? (await deps.storage.head(src.storageKey))?.size;
        if (size === undefined) throw new PublishFailure('Файл відео не знайдено');
        const file: UploadFile = {
          size,
          contentType: 'video/mp4',
          open: (from) => deps.storage.get(src.storageKey, { fromByte: from }).then((r) => r.body),
        };
        const at = pub.scheduledAt;
        const publishAt = at && at.getTime() > Date.now() + PUBLISH_AT_MIN_AHEAD_MS ? at : undefined;
        const label = `Завантаження на ${PLATFORM_LABELS[pub.platform]}`;
        await ctx.progress(0, label);

        const result = await publisher.upload({
          tokens: accessTokenFor(deps, { id: pub.accountId, platform: pub.platform }),
          file,
          meta: pub.metadata,
          language: pub.language,
          format: src.format,
          publishAt,
          resume: pub.uploadSession ?? undefined,
          // URI сесії — до передачі байтів: після рестарту завантаження продовжиться з нього
          onSession: async (uri) => {
            await deps.db.update(publications).set({ uploadSession: uri, updatedAt: new Date() }).where(mine);
          },
          onProgress: (pct) => ctx.progress(pct, label),
          signal: ctx.signal,
        });
        const now = new Date();
        await deps.db
          .update(publications)
          .set({
            status: 'processing',
            processingSince: now,
            platformPostId: result.platformPostId,
            url: result.url,
            uploadSession: null,
            error: null,
            updatedAt: now,
          })
          .where(and(mine, eq(publications.status, 'uploading')));
      } catch (e) {
        if (ctx.signal.aborted) {
          // скасування користувачем → cancelled; зупинка сервера → лишаємо uploading (відновлення продовжить)
          const [j] = await deps.db
            .select({ cancelRequested: jobs.cancelRequested })
            .from(jobs)
            .where(eq(jobs.id, ctx.jobId));
          if (j?.cancelRequested) {
            await deps.db
              .update(publications)
              .set({ status: 'cancelled', updatedAt: new Date() })
              .where(and(mine, inArray(publications.status, ['scheduled', 'uploading'])));
          }
          throw e;
        }
        const message = publishErrorMessage(e);
        // upload_session лишається: «Повторити» продовжить ту саму сесію
        await deps.db
          .update(publications)
          .set({ status: 'failed', error: message, updatedAt: new Date() })
          .where(and(mine, eq(publications.status, 'uploading')));
        if (e instanceof PublishError && e.reason === 'auth' && e.platformReason !== 'youtubeSignupRequired') {
          await deps.db
            .update(socialAccounts)
            .set({ status: 'reauth_required', updatedAt: new Date() })
            .where(eq(socialAccounts.id, pub.accountId));
        }
        throw new Error(message, { cause: e });
      }
    },
  };
}
