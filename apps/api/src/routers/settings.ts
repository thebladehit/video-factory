import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { userSettings } from '@vf/db';
import { AppError, CAPABILITIES, type Capability, type ModelRef } from '@vf/shared';
import { procedure, router } from '../trpc';

const modelRef = z.string().regex(/^[a-z]+\/.+$/) as unknown as z.ZodType<ModelRef>;

export const settingsRouter = router({
  get: procedure.query(async ({ ctx }) => {
    const [row] = await ctx.deps.db.select().from(userSettings).where(eq(userSettings.userId, ctx.userId));
    const catalog = await ctx.deps.ai.catalog(ctx.userId);
    const defaults = Object.fromEntries(
      CAPABILITIES.map((cap) => {
        const ref = row?.defaults[cap];
        if (!ref) return [cap, null];
        const available = catalog.some((i) => i.ref === ref && i.capability === cap && i.available);
        return [cap, { ref, available }];
      }),
    ) as Record<Capability, { ref: ModelRef; available: boolean } | null>;
    return { defaults, channelStyle: row?.channelStyle ?? '' };
  }),

  setDefault: procedure
    .input(z.object({ capability: z.enum(CAPABILITIES), ref: modelRef }))
    .mutation(async ({ ctx, input }) => {
      const entry = (await ctx.deps.ai.catalog(ctx.userId)).find(
        (i) => i.ref === input.ref && i.capability === input.capability,
      );
      if (!entry) throw new AppError('MODEL_NOT_FOUND', `Модель ${input.ref} не підходить для «${input.capability}»`);
      if (!entry.available) throw new AppError('MODEL_UNAVAILABLE', `Немає ключа для провайдера ${entry.provider}`);
      const [row] = await ctx.deps.db.select().from(userSettings).where(eq(userSettings.userId, ctx.userId));
      await ctx.deps.db
        .update(userSettings)
        .set({ defaults: { ...row?.defaults, [input.capability]: input.ref }, updatedAt: new Date() })
        .where(eq(userSettings.userId, ctx.userId));
    }),

  setChannelStyle: procedure.input(z.object({ text: z.string().max(4000) })).mutation(async ({ ctx, input }) => {
    await ctx.deps.db
      .update(userSettings)
      .set({ channelStyle: input.text, updatedAt: new Date() })
      .where(eq(userSettings.userId, ctx.userId));
  }),
});
