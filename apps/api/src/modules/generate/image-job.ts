import { and, eq, inArray } from 'drizzle-orm';
import { estimateCost, type Aspect } from '@vf/ai';
import { assets, generations } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import type { ModelRef } from '@vf/shared';
import type { AppDeps } from '../../app';
import { setGenerationStatus, storeGeneratedFiles } from './store-files';

/** image.generate: адаптер → файли в S3 → assets → asset.process. Повтор не генерує вдруге. */
export function imageGenerateJob(deps: AppDeps): JobDef<{ generationId: string }, { assetIds: string[] }> {
  return {
    type: 'image.generate',
    concurrency: 2,
    async handler({ generationId }, ctx) {
      const [g] = await deps.db.select().from(generations).where(eq(generations.id, generationId));
      if (!g) return { assetIds: [] };
      if (g.assetIds.length) {
        // уже згенеровано — лише догнати обробку
        const stuck = await deps.db
          .select({ id: assets.id })
          .from(assets)
          .where(and(inArray(assets.id, g.assetIds), eq(assets.status, 'processing')));
        for (const { id } of stuck)
          await deps.jobs.queue.enqueue('asset.process', { assetId: id }, { userId: g.userId });
        return { assetIds: g.assetIds };
      }
      const ref = `${g.provider}/${g.model}` as ModelRef;
      const { aspect, n } = g.params as { aspect: Aspect; n: number };
      await setGenerationStatus(deps, g.id, { status: 'running', error: null });
      try {
        await ctx.progress(10, 'Генерую');
        const files = await (
          await deps.ai.image(g.userId, ref)
        ).generate({ prompt: g.prompt ?? '', aspect, n, signal: ctx.signal });
        await ctx.progress(80, 'Зберігаю');
        const assetIds = await storeGeneratedFiles(deps, g, files);
        const entry = (await deps.ai.catalog(g.userId)).find((e) => e.ref === ref);
        const cost = entry ? estimateCost(entry, { images: files.length }) : null;
        await setGenerationStatus(deps, g.id, { status: 'done', costEstimate: cost === null ? null : cost.toFixed(6) });
        return { assetIds };
      } catch (e) {
        // скасування користувачем чи зупинка сервера: стан бере задача (див. listGenerations),
        // а перервану рестартом генерацію відновлення підхопить з provider_op
        if (!ctx.signal.aborted)
          await setGenerationStatus(deps, g.id, { status: 'failed', error: (e as Error).message });
        throw e;
      }
    },
  };
}
