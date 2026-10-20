import { z } from 'zod';
import { procedure, router } from '../../trpc';
import { abortUpload, completeUpload, createUpload, listUploadedParts, signParts } from './service';

const assetId = z.object({ assetId: z.string() });

export const assetsRouter = router({
  createUpload: procedure
    .input(z.object({ name: z.string().min(1).max(255), mime: z.string().max(100), size: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => createUpload(ctx.deps, ctx.userId, input)),

  signParts: procedure
    .input(z.object({ assetId: z.string(), partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100) }))
    .mutation(({ ctx, input }) => signParts(ctx.deps, ctx.userId, input)),

  listParts: procedure.input(assetId).query(({ ctx, input }) => listUploadedParts(ctx.deps, ctx.userId, input.assetId)),

  complete: procedure
    .input(
      z.object({
        assetId: z.string(),
        parts: z.array(z.object({ PartNumber: z.number().int().min(1), ETag: z.string() })).optional(),
      }),
    )
    .mutation(({ ctx, input }) => completeUpload(ctx.deps, ctx.userId, input)),

  abort: procedure.input(assetId).mutation(({ ctx, input }) => abortUpload(ctx.deps, ctx.userId, input.assetId)),
});
