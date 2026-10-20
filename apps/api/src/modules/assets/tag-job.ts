import { eq } from 'drizzle-orm';
import { assets } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import { AppError } from '@vf/shared';
import type { AppDeps } from '../../app';
import { resolveTagger, tagWithVision } from './tagger';

/** assets.tag — ручне тегування з картки файлу */
export function assetsTagJob(deps: AppDeps): JobDef<{ assetId: string }, void> {
  return {
    type: 'assets.tag',
    concurrency: 2,
    async handler({ assetId }, ctx) {
      const [row] = await deps.db.select().from(assets).where(eq(assets.id, assetId));
      if (!row || row.status !== 'ready') return;
      if (!(await resolveTagger(deps, row.userId))) {
        throw new AppError('MODEL_UNAVAILABLE', 'Немає доступної моделі для тегів — додайте ключ провайдера');
      }
      await tagWithVision(deps, row, { signal: ctx.signal });
    },
  };
}
