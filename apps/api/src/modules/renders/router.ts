import { z } from 'zod';
import { procedure, router } from '../../trpc';
import { cancelRender, listRenders, retryRender, startAllRenders, startRender } from './service';

const byId = z.object({ id: z.string() });
const preset = z.enum(['final', 'draft']);

export const rendersRouter = router({
  start: procedure
    .input(
      z.object({
        projectId: z.string(),
        preset,
        version: z.number().int().min(1),
        language: z.string().optional(),
        force: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => startRender(ctx.deps, ctx.userId, input)),
  startAll: procedure
    .input(
      z.object({
        projectId: z.string(),
        preset,
        languages: z.array(z.string()).min(1).max(20),
        force: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => startAllRenders(ctx.deps, ctx.userId, input)),
  list: procedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listRenders(ctx.deps, ctx.userId, input.projectId)),
  cancel: procedure.input(byId).mutation(({ ctx, input }) => cancelRender(ctx.deps, ctx.userId, input.id)),
  retry: procedure.input(byId).mutation(({ ctx, input }) => retryRender(ctx.deps, ctx.userId, input.id)),
});
