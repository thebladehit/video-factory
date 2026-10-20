import { z } from 'zod';
import type { ModelRef } from '@vf/shared';
import { procedure, router } from '../../trpc';
import { estimate, generateImage, generateVideo, listGenerations } from './service';

const modelRef = z.string().regex(/^[a-z]+\/.+$/) as unknown as z.ZodType<ModelRef>;
const aspect = z.enum(['9:16', '16:9', '1:1']);
const prompt = z.string().min(1).max(4000);

export const generateRouter = router({
  image: procedure
    .input(z.object({ model: modelRef, prompt, aspect, n: z.number().int().min(1).max(10) }))
    .mutation(({ ctx, input }) => generateImage(ctx.deps, ctx.userId, input)),

  video: procedure
    .input(z.object({ model: modelRef, prompt, aspect, durationSec: z.number().int().min(1).max(60).optional() }))
    .mutation(({ ctx, input }) => generateVideo(ctx.deps, ctx.userId, input)),

  estimate: procedure
    .input(
      z.object({
        capability: z.enum(['image', 'video']),
        model: modelRef,
        n: z.number().int().min(1).max(10).optional(),
        durationSec: z.number().int().min(1).max(60).optional(),
      }),
    )
    .query(({ ctx, input }) => estimate(ctx.deps, ctx.userId, input)),

  list: procedure.query(({ ctx }) => listGenerations(ctx.deps, ctx.userId)),
});
