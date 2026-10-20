import { z } from 'zod';
import { procedure, router } from '../../trpc';
import { cancelRender, listRenders, retryRender, startRender } from './service';

const byId = z.object({ id: z.string() });

export const rendersRouter = router({
  start: procedure
    .input(z.object({ projectId: z.string(), preset: z.enum(['final', 'draft']), version: z.number().int().min(1) }))
    .mutation(({ ctx, input }) => startRender(ctx.deps, ctx.userId, input)),
  list: procedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listRenders(ctx.deps, ctx.userId, input.projectId)),
  cancel: procedure.input(byId).mutation(({ ctx, input }) => cancelRender(ctx.deps, ctx.userId, input.id)),
  retry: procedure.input(byId).mutation(({ ctx, input }) => retryRender(ctx.deps, ctx.userId, input.id)),
});
