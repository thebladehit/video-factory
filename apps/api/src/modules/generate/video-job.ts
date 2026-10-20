import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { estimateCost, type Aspect, type GeneratedFile, type OpRef } from '@vf/ai';
import { probe } from '@vf/media';
import { assets, generations } from '@vf/db';
import type { JobDef } from '@vf/jobs';
import type { ModelRef } from '@vf/shared';
import type { AppDeps } from '../../app';
import { setGenerationStatus, storeGeneratedFiles } from './store-files';

const EXPECTED_MS = 120_000;

/** Тривалість для вартості: від провайдера, інакше — виміряна ffprobe (Omni її не повідомляє). */
async function measuredMs(deps: AppDeps, f: GeneratedFile, durationSec: number | null): Promise<number> {
  if (f.durationMs) return f.durationMs;
  const dir = await mkdtemp(join(tmpdir(), 'vf-gen-'));
  try {
    await writeFile(join(dir, 'v'), f.bytes);
    return (await probe(deps.media, join(dir, 'v'))).durationMs ?? (durationSec ?? 0) * 1000;
  } catch {
    return (durationSec ?? 0) * 1000;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * video.generate: start → provider_op одразу в БД → poll до готовності → asset.
 * Після рестарту продовжує опитування збереженої операції, а не запускає (і не оплачує) нову.
 */
export function videoGenerateJob(
  deps: AppDeps,
  opts: { pollMs: number; timeoutMs: number },
): JobDef<{ generationId: string }, { assetIds: string[] }> {
  return {
    type: 'video.generate',
    concurrency: 2,
    async handler({ generationId }, ctx) {
      const [g] = await deps.db.select().from(generations).where(eq(generations.id, generationId));
      if (!g) return { assetIds: [] };
      if (g.assetIds.length) {
        // файли вже збережено (збій стався пізніше) — лише догнати обробку
        const stuck = await deps.db
          .select({ id: assets.id })
          .from(assets)
          .where(and(inArray(assets.id, g.assetIds), eq(assets.status, 'processing')));
        for (const { id } of stuck)
          await deps.jobs.queue.enqueue('asset.process', { assetId: id }, { userId: g.userId });
        if (g.status !== 'done') await setGenerationStatus(deps, g.id, { status: 'done', error: null });
        return { assetIds: g.assetIds };
      }
      const ref = `${g.provider}/${g.model}` as ModelRef;
      const { aspect, durationSec } = g.params as { aspect: Aspect; durationSec: number | null };
      await setGenerationStatus(deps, g.id, { status: 'running', error: null });
      try {
        const video = await deps.ai.video(g.userId, ref);
        let op = g.providerOp as OpRef | null;
        if (!op) {
          op = await video.start({
            prompt: g.prompt ?? '',
            aspect,
            durationSec: durationSec ?? undefined,
            signal: ctx.signal,
          });
          await setGenerationStatus(deps, g.id, { providerOp: op });
        }
        const started = Date.now();
        for (;;) {
          const state = await video.poll(op, { signal: ctx.signal });
          if (Array.isArray(state)) {
            await ctx.progress(95, 'Зберігаю');
            const assetIds = await storeGeneratedFiles(deps, g, state);
            const seconds =
              (await Promise.all(state.map((f) => measuredMs(deps, f, durationSec)))).reduce((a, b) => a + b, 0) / 1000;
            const entry = (await deps.ai.catalog(g.userId)).find((e) => e.ref === ref);
            const cost = entry ? estimateCost(entry, { seconds }) : null;
            await setGenerationStatus(deps, g.id, {
              status: 'done',
              costEstimate: cost === null ? null : cost.toFixed(6),
            });
            return { assetIds };
          }
          if (state.state === 'failed') throw new Error(state.error);
          const elapsed = Date.now() - started;
          if (elapsed > opts.timeoutMs) {
            throw new Error(`Перевищено час очікування генерації (${Math.round(opts.timeoutMs / 60_000)} хв)`);
          }
          await ctx.progress(Math.min(90, 5 + (elapsed / EXPECTED_MS) * 85), 'Генерую відео');
          await sleep(opts.pollMs, undefined, { signal: ctx.signal });
        }
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
