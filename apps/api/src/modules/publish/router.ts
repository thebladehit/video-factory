import { z } from 'zod';
import { PLATFORMS, PUBLICATION_STATUSES, publicationMetaSchema } from '@vf/shared';
import { procedure, router } from '../../trpc';
import {
  cancelPublication,
  createPublications,
  downloadUrl,
  listPublications,
  listVersions,
  markPublished,
  pendingCount,
  retryPublication,
  updateMeta,
} from './service';
import { generateMeta } from './meta';
import { connectUrl, createManualAccount, listAccounts, removeAccount, updateAccount } from './accounts';

const accountsRouter = router({
  list: procedure.query(({ ctx }) => listAccounts(ctx.deps, ctx.userId)),
  createManual: procedure
    .input(
      z.object({
        platform: z.enum(PLATFORMS),
        name: z.string(),
        language: z.string(),
        profileUrl: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => createManualAccount(ctx.deps, ctx.userId, input)),
  update: procedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        language: z.string().optional(),
        // порожній рядок — прибрати посилання
        profileUrl: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateAccount(ctx.deps, ctx.userId, input)),
  remove: procedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeAccount(ctx.deps, ctx.userId, input.id)),
  connectUrl: procedure
    .input(z.object({ platform: z.literal('youtube'), language: z.string() }))
    .mutation(({ ctx, input }) => connectUrl(ctx.deps, ctx.userId, input)),
});

export const publishRouter = router({
  accounts: accountsRouter,
  versions: procedure
    .input(z.object({ projectId: z.string().optional() }).optional())
    .query(({ ctx, input }) => listVersions(ctx.deps, ctx.userId, input?.projectId)),
  generateMeta: procedure
    .input(z.object({ projectId: z.string(), language: z.string(), force: z.boolean().optional() }))
    .mutation(({ ctx, input }) => generateMeta(ctx.deps, ctx.userId, input)),
  create: procedure
    .input(
      z.object({
        items: z.array(
          z.object({
            renderId: z.string(),
            accountId: z.string(),
            meta: publicationMetaSchema,
            scheduledAt: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(({ ctx, input }) => createPublications(ctx.deps, ctx.userId, input.items)),
  list: procedure
    .input(z.object({ projectId: z.string().optional(), status: z.enum(PUBLICATION_STATUSES).optional() }).optional())
    .query(({ ctx, input }) => listPublications(ctx.deps, ctx.userId, input ?? {})),
  pendingCount: procedure.query(({ ctx }) => pendingCount(ctx.deps, ctx.userId)),
  downloadUrl: procedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => downloadUrl(ctx.deps, ctx.userId, input.id)),
  markPublished: procedure
    .input(z.object({ id: z.string(), url: z.string() }))
    .mutation(({ ctx, input }) => markPublished(ctx.deps, ctx.userId, input)),
  updateMeta: procedure
    .input(z.object({ id: z.string(), meta: publicationMetaSchema, scheduledAt: z.string().nullable().optional() }))
    .mutation(({ ctx, input }) => updateMeta(ctx.deps, ctx.userId, input)),
  cancel: procedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => cancelPublication(ctx.deps, ctx.userId, input.id)),
  retry: procedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => retryPublication(ctx.deps, ctx.userId, input.id)),
});
