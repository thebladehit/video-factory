import { z } from 'zod';
import { PLATFORMS } from '@vf/shared';
import { procedure, router } from '../../trpc';
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
});
