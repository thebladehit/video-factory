import { and, asc, eq } from 'drizzle-orm';
import { assets, pipelineRuns, pipelineScenes, projects } from '@vf/db';
import { normalizeDoc } from '@vf/shared';
import { replaceSegmentVisual, type SceneVisual } from '@vf/timeline';
import type { AppDeps } from '../../app';
import { timelineAssetIds } from '../projects/service';

type AssetRow = Pick<typeof assets.$inferSelect, 'id' | 'kind' | 'status' | 'width' | 'height' | 'durationMs'>;

/** Візуал сцени з рядка asset: лише готові фото/відео, інакше null. Невідомі розміри → 0 (тоді `cover`). */
export function sceneVisualOf(a: AssetRow | undefined): SceneVisual | null {
  if (!a || a.status !== 'ready' || (a.kind !== 'image' && a.kind !== 'video')) return null;
  return {
    assetId: a.id,
    kind: a.kind,
    ...(a.kind === 'video' && a.durationMs != null ? { durationSec: a.durationMs / 1000 } : {}),
    width: a.width ?? 0,
    height: a.height ?? 0,
  };
}

/**
 * Після `done`: точкова заміна кліпів сегмента сцени на її поточний візуал (`replaceSegmentVisual` на актуальній
 * версії документа під `for update`), версія +1. Індекс сцени — за `position`, як у повній збірці (чергування
 * Ken Burns). Сегмента немає (видалено в редакторі), візуал не готовий або нічого не змінилось — документ не
 * чіпається. true — документ змінено.
 */
export async function applySceneVisual(deps: AppDeps, sceneId: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ scene: pipelineScenes, run: pipelineRuns })
      .from(pipelineScenes)
      .innerJoin(pipelineRuns, eq(pipelineRuns.id, pipelineScenes.runId))
      .where(eq(pipelineScenes.id, sceneId));
    if (!row?.scene.visualAssetId) return false;
    const { scene, run } = row;
    const [p] = await tx.select().from(projects).where(eq(projects.id, run.projectId)).for('update');
    if (!p) return false;
    const [a] = await tx
      .select()
      .from(assets)
      .where(and(eq(assets.id, scene.visualAssetId!), eq(assets.userId, run.userId)));
    const visual = sceneVisualOf(a);
    if (!visual) return false;
    const order = await tx
      .select({ id: pipelineScenes.id })
      .from(pipelineScenes)
      .where(eq(pipelineScenes.runId, run.id))
      .orderBy(asc(pipelineScenes.position));
    const index = order.findIndex((o) => o.id === scene.id);
    const doc = normalizeDoc(p.timeline);
    const next = replaceSegmentVisual(doc, scene.segmentId, visual, Math.max(0, index));
    if (next === doc) return false;
    await tx
      .update(projects)
      .set({
        timeline: next,
        timelineVersion: p.timelineVersion + 1,
        assetIds: timelineAssetIds(next),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, p.id));
    return true;
  });
}
