import { z } from 'zod';
import { deleteAsset, getAsset, listAssets, pendingAssets, topTags, updateAsset } from './search';
import { procedure, router } from '../../trpc';
import { assetUsage } from '../projects/service';
import {
  abortUpload,
  completeUpload,
  createUpload,
  listUploadedParts,
  requestTagging,
  resignPut,
  retryProcess,
  signParts,
} from './service';

const assetId = z.object({ assetId: z.string() });
const byId = z.object({ id: z.string() });

export const assetsRouter = router({
  createUpload: procedure
    .input(z.object({ name: z.string().min(1).max(255), mime: z.string().max(100), size: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => createUpload(ctx.deps, ctx.userId, input)),

  resignPut: procedure.input(assetId).mutation(({ ctx, input }) => resignPut(ctx.deps, ctx.userId, input.assetId)),

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

  list: procedure
    .input(
      z.object({
        q: z.string().max(200).optional(),
        kind: z.enum(['image', 'video', 'audio']).optional(),
        source: z.enum(['uploaded', 'generated']).optional(),
        orientation: z.enum(['vertical', 'horizontal', 'square']).optional(),
        tags: z.array(z.string().max(40)).max(10).optional(),
        cursor: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(({ ctx, input }) => listAssets(ctx.deps, ctx.userId, input)),

  pending: procedure.query(({ ctx }) => pendingAssets(ctx.deps, ctx.userId)),

  get: procedure.input(byId).query(({ ctx, input }) => getAsset(ctx.deps, ctx.userId, input.id)),

  update: procedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().max(200).optional(),
        tags: z.array(z.string()).max(100).optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateAsset(ctx.deps, ctx.userId, input)),

  delete: procedure.input(byId).mutation(({ ctx, input }) => deleteAsset(ctx.deps, ctx.userId, input.id)),

  usage: procedure.input(byId).query(({ ctx, input }) => assetUsage(ctx.deps, ctx.userId, input.id)),

  tags: procedure.query(({ ctx }) => topTags(ctx.deps, ctx.userId)),

  tag: procedure.input(byId).mutation(({ ctx, input }) => requestTagging(ctx.deps, ctx.userId, input.id)),

  retryProcess: procedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => retryProcess(ctx.deps, ctx.userId, input.id)),

  abort: procedure.input(assetId).mutation(({ ctx, input }) => abortUpload(ctx.deps, ctx.userId, input.assetId)),
});
