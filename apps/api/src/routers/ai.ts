import { z } from 'zod';
import { parseModelRef, type ModelRef } from '@vf/shared';
import { procedure, router } from '../trpc';

export const aiRouter = router({
  catalog: procedure.query(({ ctx }) => ctx.deps.ai.catalog(ctx.userId)),

  testModel: procedure.input(z.object({ ref: z.string() })).mutation(async ({ ctx, input }) => {
    parseModelRef(input.ref);
    const text = await ctx.deps.ai.text(ctx.userId, input.ref as ModelRef);
    const started = performance.now();
    const sample = await text.generateText({ prompt: 'Відповідай одним словом: ок', maxOutputTokens: 10 });
    return { sample, ms: Math.round(performance.now() - started) };
  }),
});
