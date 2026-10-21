import { z } from 'zod';
import { procedure, router } from '../../trpc';
import { createCaptionStyle, deleteCaptionStyle, listCaptionStyles, updateCaptionStyle } from './service';

const name = z.string();

export const captionStylesRouter = router({
  list: procedure.query(({ ctx }) => listCaptionStyles(ctx.deps, ctx.userId)),
  create: procedure
    .input(z.object({ name, style: z.unknown() }))
    .mutation(({ ctx, input }) => createCaptionStyle(ctx.deps, ctx.userId, input)),
  update: procedure
    .input(z.object({ id: z.string(), name: name.optional(), style: z.unknown().optional() }))
    .mutation(({ ctx, input }) => updateCaptionStyle(ctx.deps, ctx.userId, input)),
  delete: procedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteCaptionStyle(ctx.deps, ctx.userId, input.id)),
});
