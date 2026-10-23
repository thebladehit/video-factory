import { and, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { assets, projects, publications, renders, socialAccounts } from '@vf/db';
import { parsePostUrl, validateMeta } from '@vf/publish';
import {
  AppError,
  LIVE_PUBLICATION_STATUSES,
  PLATFORM_LABELS,
  type Platform,
  type PublicationMeta,
  type PublicationStatus,
  type PublishMethod,
  type VideoFormat,
} from '@vf/shared';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { enqueuePublish } from './job';

const LIVE = [...LIVE_PUBLICATION_STATUSES];
const EDITABLE: PublicationStatus[] = ['scheduled', 'awaiting_manual'];
/** YouTube приймає publishAt лише з запасом від поточного часу */
const YOUTUBE_MIN_AHEAD_MS = 5 * 60_000;
const CONFLICT_MESSAGE = 'Ця версія вже публікується на цей акаунт';
const LIVE_MESSAGE = 'Є публікації в роботі — скасуйте їх або дочекайтесь завершення';
const UNIQUE_INDEX = 'publications_render_account_live_key';
const notFound = () => new AppError('NOT_FOUND', 'Публікацію не знайдено');

export interface PublishVersion {
  projectId: string;
  projectTitle: string;
  format: VideoFormat;
  language: string;
  renderId: string;
  durationMs: number | null;
  thumbKey: string | null;
  renderedAt: Date;
}

/** Останній готовий фінальний рендер на кожну пару (проєкт, мова) */
export async function listVersions(deps: AppDeps, userId: string, projectId?: string): Promise<PublishVersion[]> {
  if (projectId !== undefined && !isUuid(projectId)) return [];
  const rows = await deps.db
    .select({
      projectId: projects.id,
      projectTitle: projects.title,
      format: projects.format,
      language: sql<string>`coalesce(${renders.language}, ${projects.baseLanguage})`,
      renderId: renders.id,
      durationMs: assets.durationMs,
      thumbKey: assets.thumbKey,
      renderedAt: sql<Date>`coalesce(${renders.finishedAt}, ${renders.createdAt})`,
    })
    .from(renders)
    .innerJoin(projects, eq(projects.id, renders.projectId))
    .innerJoin(assets, eq(assets.id, renders.outputAssetId))
    .where(
      and(
        eq(renders.userId, userId),
        eq(renders.status, 'done'),
        eq(renders.preset, 'final'),
        isNotNull(renders.outputAssetId),
        projectId ? eq(renders.projectId, projectId) : undefined,
      ),
    )
    .orderBy(desc(renders.createdAt));
  // рендери відсортовано від нових: перший на пару (проєкт, мова) — найсвіжіший
  const seen = new Set<string>();
  const out: PublishVersion[] = [];
  for (const r of rows) {
    const key = `${r.projectId}:${r.language}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, renderedAt: new Date(r.renderedAt) });
  }
  return out;
}

export interface CreateItem {
  renderId: string;
  accountId: string;
  meta: PublicationMeta;
  scheduledAt?: string;
}

function parseTime(raw: string | null | undefined): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new AppError('VALIDATION', 'Некоректний час публікації');
  return d;
}

function checkMeta(platform: Platform, meta: PublicationMeta) {
  const errors = validateMeta(platform, meta);
  if (errors.length) throw new AppError('VALIDATION', errors[0]!, { errors });
}

function checkYoutubeTime(platform: Platform, at: Date | null) {
  if (platform !== 'youtube' || !at) return;
  const now = Date.now();
  if (at.getTime() > now && at.getTime() <= now + YOUTUBE_MIN_AHEAD_MS) {
    throw new AppError('VALIDATION', 'Час публікації на YouTube має бути щонайменше через 5 хвилин');
  }
}

/** Порушення часткового unique (render_id, account_id) → CONFLICT */
function mapUnique(e: unknown): never {
  for (let cur: unknown = e, i = 0; cur && i < 4; i++, cur = (cur as { cause?: unknown }).cause) {
    const err = cur as { code?: string; constraint_name?: string; constraint?: string };
    if (err.code === '23505' && (err.constraint_name ?? err.constraint ?? UNIQUE_INDEX) === UNIQUE_INDEX) {
      throw new AppError('CONFLICT', CONFLICT_MESSAGE);
    }
  }
  throw e;
}

export async function createPublications(deps: AppDeps, userId: string, items: CreateItem[]): Promise<string[]> {
  if (!items.length) throw new AppError('VALIDATION', 'Оберіть хоча б одну версію й акаунт');
  let created: { id: string; method: PublishMethod }[];
  try {
    created = await deps.db.transaction(async (tx) => {
      const rows: { id: string; method: PublishMethod }[] = [];
      for (const item of items) {
        if (!isUuid(item.renderId) || !isUuid(item.accountId))
          throw new AppError('NOT_FOUND', 'Версію чи акаунт не знайдено');
        const [render] = await tx
          .select({
            id: renders.id,
            projectId: renders.projectId,
            language: sql<string>`coalesce(${renders.language}, ${projects.baseLanguage})`,
          })
          .from(renders)
          .innerJoin(projects, eq(projects.id, renders.projectId))
          .where(
            and(
              eq(renders.id, item.renderId),
              eq(renders.userId, userId),
              eq(renders.status, 'done'),
              eq(renders.preset, 'final'),
              isNotNull(renders.outputAssetId),
            ),
          );
        if (!render) throw new AppError('NOT_FOUND', 'Готовий фінальний рендер не знайдено');
        const [account] = await tx
          .select()
          .from(socialAccounts)
          .where(and(eq(socialAccounts.id, item.accountId), eq(socialAccounts.userId, userId)));
        if (!account) throw new AppError('NOT_FOUND', 'Акаунт не знайдено');
        if (account.status !== 'active') {
          throw new AppError('VALIDATION', 'Акаунт потребує повторного підключення');
        }
        checkMeta(account.platform, item.meta);
        const at = parseTime(item.scheduledAt);
        checkYoutubeTime(account.platform, at);
        // api: рядок у scheduled, задачу ставимо після коміту; manual «зараз» — одразу до ручної черги
        const status: PublicationStatus =
          account.method === 'manual' && (!at || at.getTime() <= Date.now()) ? 'awaiting_manual' : 'scheduled';
        const [row] = await tx
          .insert(publications)
          .values({
            userId,
            projectId: render.projectId,
            renderId: render.id,
            language: render.language,
            platform: account.platform,
            accountId: account.id,
            method: account.method,
            status,
            scheduledAt: at,
            metadata: item.meta,
          })
          .returning({ id: publications.id, method: publications.method });
        rows.push(row!);
      }
      return rows;
    });
  } catch (e) {
    return mapUnique(e);
  }
  // задача ставиться одразу, «зараз» чи за розкладом (scheduled_at — час виходу на платформі)
  for (const p of created) if (p.method === 'api') await startPublish(deps, { id: p.id, userId });
  return created.map((p) => p.id);
}

/** Збій постановки не скасовує створення: тік поставить задачу для scheduled без живої задачі */
async function startPublish(deps: AppDeps, pub: { id: string; userId: string }) {
  try {
    await enqueuePublish(deps, pub);
  } catch (e) {
    deps.log.error({ err: e, publicationId: pub.id }, 'publish: не вдалося поставити задачу');
  }
}

/** Публікація для клієнта: без внутрішнього `uploadSession` */
const listColumns = {
  id: publications.id,
  projectId: publications.projectId,
  renderId: publications.renderId,
  language: publications.language,
  platform: publications.platform,
  accountId: publications.accountId,
  method: publications.method,
  status: publications.status,
  scheduledAt: publications.scheduledAt,
  metadata: publications.metadata,
  jobId: publications.jobId,
  platformPostId: publications.platformPostId,
  url: publications.url,
  error: publications.error,
  publishedAt: publications.publishedAt,
  createdAt: publications.createdAt,
  updatedAt: publications.updatedAt,
};

export async function listPublications(
  deps: AppDeps,
  userId: string,
  filter: { projectId?: string; status?: PublicationStatus } = {},
) {
  if (filter.projectId !== undefined && !isUuid(filter.projectId)) return [];
  return deps.db
    .select(listColumns)
    .from(publications)
    .where(
      and(
        eq(publications.userId, userId),
        filter.projectId ? eq(publications.projectId, filter.projectId) : undefined,
        filter.status ? eq(publications.status, filter.status) : undefined,
      ),
    )
    .orderBy(desc(publications.createdAt));
}

export async function pendingCount(deps: AppDeps, userId: string): Promise<number> {
  const [row] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(publications)
    .where(and(eq(publications.userId, userId), eq(publications.status, 'awaiting_manual')));
  return row?.n ?? 0;
}

async function ownPublication(deps: AppDeps, userId: string, id: string) {
  if (!isUuid(id)) throw notFound();
  const [row] = await deps.db
    .select()
    .from(publications)
    .where(and(eq(publications.id, id), eq(publications.userId, userId)));
  if (!row) throw notFound();
  return row;
}

export async function downloadUrl(deps: AppDeps, userId: string, id: string): Promise<{ url: string }> {
  const pub = await ownPublication(deps, userId, id);
  const [row] = await deps.db
    .select({ storageKey: assets.storageKey, title: projects.title })
    .from(renders)
    .innerJoin(assets, eq(assets.id, renders.outputAssetId))
    .innerJoin(projects, eq(projects.id, renders.projectId))
    .where(eq(renders.id, pub.renderId));
  if (!row) throw new AppError('NOT_FOUND', 'Файл відео не знайдено');
  const name = `${row.title || 'video'}-${pub.language}.mp4`.replace(/[\\/:*?"<>|\r\n]+/g, ' ');
  return { url: await deps.storage.presignGet(row.storageKey, { downloadName: name }) };
}

/** Перша опублікована публікація проєкту робить його `published` (ручний шлях і задача) */
export async function markProjectPublished(deps: AppDeps, projectId: string): Promise<void> {
  await deps.db
    .update(projects)
    .set({ status: 'published', updatedAt: new Date() })
    .where(and(eq(projects.id, projectId), sql`${projects.status} <> 'published'`));
}

export async function markPublished(deps: AppDeps, userId: string, input: { id: string; url: string }) {
  const pub = await ownPublication(deps, userId, input.id);
  if (pub.method !== 'manual') throw new AppError('VALIDATION', 'Посилання вставляється лише для ручних публікацій');
  if (!LIVE.includes(pub.status)) throw new AppError('CONFLICT', 'Публікація вже завершена');
  const url = input.url.trim();
  const parsed = parsePostUrl(pub.platform, url);
  if (!parsed) throw new AppError('VALIDATION', `Це не посилання на ${PLATFORM_LABELS[pub.platform]}`);
  const now = new Date();
  const [row] = await deps.db
    .update(publications)
    .set({
      status: 'published',
      url,
      platformPostId: parsed.platformPostId,
      publishedAt: now,
      error: null,
      updatedAt: now,
    })
    .where(and(eq(publications.id, pub.id), inArray(publications.status, LIVE)))
    .returning({ id: publications.id });
  if (!row) throw new AppError('CONFLICT', 'Публікація вже завершена');
  await markProjectPublished(deps, pub.projectId);
}

export async function updateMeta(
  deps: AppDeps,
  userId: string,
  input: { id: string; meta: PublicationMeta; scheduledAt?: string | null },
) {
  const pub = await ownPublication(deps, userId, input.id);
  if (!EDITABLE.includes(pub.status)) {
    throw new AppError('CONFLICT', 'Змінювати можна лише заплановані публікації');
  }
  checkMeta(pub.platform, input.meta);
  const patch: Partial<typeof publications.$inferInsert> = { metadata: input.meta, updatedAt: new Date() };
  if (input.scheduledAt !== undefined) {
    const at = parseTime(input.scheduledAt);
    checkYoutubeTime(pub.platform, at);
    patch.scheduledAt = at;
    if (pub.method === 'manual') {
      patch.status = at && at.getTime() > Date.now() ? 'scheduled' : 'awaiting_manual';
    }
  }
  const [row] = await deps.db
    .update(publications)
    .set(patch)
    .where(and(eq(publications.id, pub.id), inArray(publications.status, EDITABLE)))
    .returning({ id: publications.id });
  if (!row) throw new AppError('CONFLICT', 'Змінювати можна лише заплановані публікації');
}

export async function cancelPublication(deps: AppDeps, userId: string, id: string) {
  const pub = await ownPublication(deps, userId, id);
  if (!LIVE.includes(pub.status)) throw new AppError('CONFLICT', 'Публікація вже завершена');
  const [row] = await deps.db
    .update(publications)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(publications.id, pub.id), inArray(publications.status, LIVE)))
    .returning({ id: publications.id, jobId: publications.jobId });
  if (!row) throw new AppError('CONFLICT', 'Публікація вже завершена');
  // задача рядка (queued чи running) — за результатом UPDATE, не за попереднім читанням; завершену cancel не чіпає
  if (row.jobId) await deps.jobs.queue.cancel(row.jobId);
}

export async function retryPublication(deps: AppDeps, userId: string, id: string) {
  const pub = await ownPublication(deps, userId, id);
  if (pub.status !== 'failed') throw new AppError('CONFLICT', 'Повторити можна лише невдалу публікацію');
  const now = new Date();
  // відео вже на платформі (збій під час обробки) — лише знову опитуємо, повторне завантаження дало б дубль
  const patch: Partial<typeof publications.$inferInsert> = pub.platformPostId
    ? { status: 'processing', processingSince: now, error: null, updatedAt: now }
    : { status: 'scheduled', error: null, updatedAt: now };
  let row: { id: string } | undefined;
  try {
    [row] = await deps.db
      .update(publications)
      .set(patch)
      .where(and(eq(publications.id, pub.id), eq(publications.status, 'failed')))
      .returning({ id: publications.id });
  } catch (e) {
    mapUnique(e);
  }
  // upload_session зберігся: нова задача продовжить ту саму сесію
  if (row && pub.method === 'api' && !pub.platformPostId) await startPublish(deps, { id: pub.id, userId });
}

/** Захист видалення: проєкт чи файл рендеру з живими публікаціями видаляти не можна */
export async function assertNoLivePublications(
  deps: AppDeps,
  where: { projectId: string } | { assetId: string },
): Promise<void> {
  let cond: SQL | undefined;
  if ('projectId' in where) cond = eq(publications.projectId, where.projectId);
  else {
    const rs = await deps.db.select({ id: renders.id }).from(renders).where(eq(renders.outputAssetId, where.assetId));
    if (!rs.length) return;
    cond = inArray(
      publications.renderId,
      rs.map((r) => r.id),
    );
  }
  const [row] = await deps.db
    .select({ id: publications.id })
    .from(publications)
    .where(and(cond, inArray(publications.status, LIVE)))
    .limit(1);
  if (row) throw new AppError('CONFLICT', LIVE_MESSAGE);
}
