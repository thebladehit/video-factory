import { and, eq, inArray, sql } from 'drizzle-orm';
import { jobs, publications, socialAccounts } from '@vf/db';
import { PublishError } from '@vf/publish';
import type { Platform, PublicationStatus, PublishMethod } from '@vf/shared';
import type { AppDeps } from '../../app';
import { accessTokenFor } from './accounts';
import { enqueuePublish, publishErrorMessage } from './job';
import { markProjectPublished } from './service';

/** Опитування обробки — не частіше ніж раз на хвилину на рядок (коротший тік e2e — частіше) */
const POLL_EVERY_MS = 60_000;
/** Типовий період тіку (`PUBLISH_TICK_MS`) */
const DEFAULT_TICK_MS = 60_000;
const PROCESSING_TIMEOUT_MS = 2 * 3_600_000;
const TIMEOUT_MESSAGE = 'YouTube не завершив обробку за 2 год';

export interface TickRow {
  id: string;
  userId: string;
  platform: Platform;
  method: PublishMethod;
  status: PublicationStatus;
  scheduledAt: Date | null;
  updatedAt: Date;
  processingSince: Date | null;
  /** Є queued/running задача з publications.job_id */
  jobLive: boolean;
}

export interface TickPlan {
  toAwaiting: string[];
  toEnqueue: string[];
  toPoll: string[];
  toTimeout: string[];
}

/**
 * Чисте рішення тіку (спека §5.2): що робити з кожним рядком у момент now.
 * `tickMs` — період тіку: опитування обробки не рідше одного тіку й не частіше ніж раз на хвилину в продакшні.
 */
export function planTick(rows: TickRow[], now: Date, tickMs = DEFAULT_TICK_MS): TickPlan {
  const plan: TickPlan = { toAwaiting: [], toEnqueue: [], toPoll: [], toTimeout: [] };
  const t = now.getTime();
  const pollEveryMs = Math.min(POLL_EVERY_MS, tickMs);
  for (const r of rows) {
    if (r.method === 'manual') {
      if (r.status === 'scheduled' && (!r.scheduledAt || r.scheduledAt.getTime() <= t)) plan.toAwaiting.push(r.id);
      continue;
    }
    // api: scheduled_at — час виходу на платформі, тож задача потрібна незалежно від нього
    if (r.status === 'scheduled' && !r.jobLive) plan.toEnqueue.push(r.id);
    else if (r.status === 'processing') {
      if (r.processingSince && r.processingSince.getTime() <= t - PROCESSING_TIMEOUT_MS) plan.toTimeout.push(r.id);
      else if (r.updatedAt.getTime() <= t - pollEveryMs) plan.toPoll.push(r.id);
    }
  }
  return plan;
}

/** Тік планувальника: ідемпотентний, кожен перехід — умовний UPDATE за поточним статусом */
export async function publishTick(deps: AppDeps, now = new Date(), tickMs = DEFAULT_TICK_MS): Promise<void> {
  const rows: TickRow[] = await deps.db
    .select({
      id: publications.id,
      userId: publications.userId,
      platform: publications.platform,
      method: publications.method,
      status: publications.status,
      scheduledAt: publications.scheduledAt,
      updatedAt: publications.updatedAt,
      processingSince: publications.processingSince,
      jobLive: sql<boolean>`exists (select 1 from ${jobs} where ${jobs.id} = ${publications.jobId} and ${jobs.status} in ('queued', 'running'))`,
    })
    .from(publications)
    .where(inArray(publications.status, ['scheduled', 'processing']));
  const plan = planTick(rows, now, tickMs);
  const byId = new Map(rows.map((r) => [r.id, r]));

  if (plan.toAwaiting.length) {
    await deps.db
      .update(publications)
      .set({ status: 'awaiting_manual', updatedAt: now })
      .where(
        and(
          inArray(publications.id, plan.toAwaiting),
          eq(publications.method, 'manual'),
          eq(publications.status, 'scheduled'),
        ),
      );
  }

  for (const id of plan.toEnqueue) {
    const r = byId.get(id)!;
    // платформа без адаптера — лишається в черзі, доки його не налаштують
    if (!deps.publish.publishers[r.platform]) continue;
    try {
      await enqueuePublish(deps, r);
    } catch (e) {
      deps.log.error({ err: e, publicationId: id }, 'publish: не вдалося поставити задачу');
    }
  }

  if (plan.toTimeout.length) {
    await deps.db
      .update(publications)
      .set({ status: 'failed', error: TIMEOUT_MESSAGE, updatedAt: now })
      .where(and(inArray(publications.id, plan.toTimeout), eq(publications.status, 'processing')));
  }

  for (const id of plan.toPoll) {
    const r = byId.get(id)!;
    const publisher = deps.publish.publishers[r.platform];
    if (!publisher) continue;
    try {
      await pollProcessing(deps, r, now);
    } catch (e) {
      deps.log.error({ err: e, publicationId: id }, 'publish: не вдалося перевірити обробку');
    }
  }
}

async function pollProcessing(deps: AppDeps, r: TickRow, now: Date) {
  const processing = and(eq(publications.id, r.id), eq(publications.status, 'processing'));
  // відмітка опитування: наступне — не раніше ніж за період опитування, навіть якщо це впаде
  const [pub] = await deps.db.update(publications).set({ updatedAt: now }).where(processing).returning({
    accountId: publications.accountId,
    projectId: publications.projectId,
    platformPostId: publications.platformPostId,
  });
  if (!pub?.platformPostId) return;
  const publisher = deps.publish.publishers[r.platform]!;
  let state: Awaited<ReturnType<typeof publisher.status>>;
  try {
    state = await publisher.status(
      accessTokenFor(deps, { id: pub.accountId, platform: r.platform }),
      pub.platformPostId,
    );
  } catch (e) {
    // втрачений доступ — кінцева помилка; тимчасові — повторить наступний тік
    if (e instanceof PublishError && e.reason === 'auth') {
      await deps.db
        .update(publications)
        .set({ status: 'failed', error: publishErrorMessage(e), updatedAt: now })
        .where(processing);
      // як у задачі publish: акаунт потребує перепідключення (крім «немає каналу»)
      if (e.platformReason !== 'youtubeSignupRequired') {
        await deps.db
          .update(socialAccounts)
          .set({ status: 'reauth_required', updatedAt: now })
          .where(eq(socialAccounts.id, pub.accountId));
      }
      return;
    }
    throw e;
  }
  if (state.state === 'ready') {
    const [done] = await deps.db
      .update(publications)
      .set({ status: 'published', publishedAt: now, updatedAt: now })
      .where(processing)
      .returning({ id: publications.id });
    if (done) await markProjectPublished(deps, pub.projectId);
  } else if (state.state === 'failed') {
    await deps.db
      .update(publications)
      // відео відхилене платформою: «Повторити» має завантажити його заново
      .set({
        status: 'failed',
        error: `Помилка YouTube: ${state.error ?? 'обробку відхилено'}`,
        platformPostId: null,
        url: null,
        updatedAt: now,
      })
      .where(processing);
  }
}
