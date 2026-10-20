import { and, eq, inArray } from 'drizzle-orm';
import { assets } from '@vf/db';
import type { AssetKind, AssetStatus } from '@vf/shared';
import type { AppDeps } from '../../app';
import { hasLiveJob } from '../recovery';

export type EditorAsset =
  | {
      id: string;
      missing: false;
      kind: AssetKind;
      status: AssetStatus;
      title: string;
      url: string;
      thumbUrl: string | null;
      peaksUrl: string | null;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      hasAudio: boolean | null;
      /** Коли протухнуть підписані URL — клієнт оновлює їх за 5 хв до цього */
      urlExpiresAt: string;
    }
  | { id: string; missing: true };

const URL_TTL_SEC = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/** Файли редактора за id; чужі, видалені й не-uuid (`local:…`) → `{ missing: true }`. */
export async function editorAssets(deps: AppDeps, userId: string, ids: string[]): Promise<Record<string, EditorAsset>> {
  const unique = [...new Set(ids)];
  const valid = unique.filter(isUuid);
  const rows = valid.length
    ? await deps.db
        .select()
        .from(assets)
        .where(and(eq(assets.userId, userId), inArray(assets.id, valid)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const urlExpiresAt = new Date(Date.now() + URL_TTL_SEC * 1000).toISOString();
  const out: Record<string, EditorAsset> = {};
  for (const id of unique) {
    const a = byId.get(id);
    if (!a || a.status === 'uploading') {
      out[id] = { id, missing: true };
      continue;
    }
    out[id] = {
      id,
      missing: false,
      kind: a.kind,
      status: a.status,
      title: a.title,
      url: await deps.storage.presignGet(a.storageKey, { expiresSec: URL_TTL_SEC }),
      thumbUrl: a.thumbKey ? await deps.storage.presignGet(a.thumbKey, { expiresSec: URL_TTL_SEC }) : null,
      peaksUrl: a.peaksKey ? await deps.storage.presignGet(a.peaksKey, { expiresSec: URL_TTL_SEC }) : null,
      width: a.width,
      height: a.height,
      durationMs: a.durationMs,
      hasAudio: a.hasAudio,
      urlExpiresAt,
    };
  }
  return out;
}

/** Відео/аудіо, оброблені до появи аналізу звуку, отримують asset.analyze, щойно їх відкрили в редакторі. */
export async function ensureAnalyzed(deps: AppDeps, userId: string, list: Record<string, EditorAsset>): Promise<void> {
  for (const a of Object.values(list)) {
    if (a.missing || a.status !== 'ready' || a.kind === 'image' || a.hasAudio !== null) continue;
    if (!(await hasLiveJob(deps, 'asset.analyze', 'assetId', a.id)))
      await deps.jobs.queue.enqueue('asset.analyze', { assetId: a.id }, { userId });
  }
}
