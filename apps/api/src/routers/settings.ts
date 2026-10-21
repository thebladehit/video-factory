import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { userSettings } from '@vf/db';
import {
  AppError,
  languageInfo,
  voiceDefaultsSchema,
  type VoiceChoice,
  DEFAULT_SLOTS,
  type DefaultSlot,
  type ModelRef,
} from '@vf/shared';
import { assertVoiceChoice, userVoiceDefaults } from '../modules/voice/service';
import { procedure, router } from '../trpc';

/** Модель для тегів — текстова */
const capabilityOf = (slot: DefaultSlot) => (slot === 'tagger' ? 'text' : slot);

const modelRef = z.string().regex(/^[a-z]+\/.+$/) as unknown as z.ZodType<ModelRef>;

export const settingsRouter = router({
  get: procedure.query(async ({ ctx }) => {
    const [row] = await ctx.deps.db.select().from(userSettings).where(eq(userSettings.userId, ctx.userId));
    const catalog = await ctx.deps.ai.catalog(ctx.userId);
    const defaults = Object.fromEntries(
      DEFAULT_SLOTS.map((slot) => {
        const ref = row?.defaults[slot];
        if (!ref) return [slot, null];
        const available = catalog.some((i) => i.ref === ref && i.capability === capabilityOf(slot) && i.available);
        return [slot, { ref, available }];
      }),
    ) as Record<DefaultSlot, { ref: ModelRef; available: boolean } | null>;
    return {
      defaults,
      channelStyle: row?.channelStyle ?? '',
      autoTagUploads: row?.autoTagUploads ?? false,
      voices: await userVoiceDefaults(ctx.deps, ctx.userId),
    };
  }),

  setDefault: procedure
    .input(z.object({ capability: z.enum(DEFAULT_SLOTS), ref: modelRef }))
    .mutation(async ({ ctx, input }) => {
      const entry = (await ctx.deps.ai.catalog(ctx.userId)).find(
        (i) => i.ref === input.ref && i.capability === capabilityOf(input.capability),
      );
      if (!entry) throw new AppError('MODEL_NOT_FOUND', `Модель ${input.ref} не підходить для «${input.capability}»`);
      if (!entry.available) throw new AppError('MODEL_UNAVAILABLE', `Немає ключа для провайдера ${entry.provider}`);
      // upsert + jsonb-злиття: працює без рядка налаштувань і не губить паралельні зміни
      await ctx.deps.db
        .insert(userSettings)
        .values({ userId: ctx.userId, defaults: { [input.capability]: input.ref } })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { defaults: sql`${userSettings.defaults} || excluded.defaults`, updatedAt: new Date() },
        });
    }),

  setChannelStyle: procedure.input(z.object({ text: z.string().max(4000) })).mutation(async ({ ctx, input }) => {
    await ctx.deps.db
      .insert(userSettings)
      .values({ userId: ctx.userId, channelStyle: input.text })
      .onConflictDoUpdate({ target: userSettings.userId, set: { channelStyle: input.text, updatedAt: new Date() } });
  }),

  setAutoTag: procedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    await ctx.deps.db
      .insert(userSettings)
      .values({ userId: ctx.userId, autoTagUploads: input.enabled })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { autoTagUploads: input.enabled, updatedAt: new Date() },
      });
  }),

  /** Голос за замовчуванням для мови; `voice: null` — прибрати. */
  setVoice: procedure
    .input(
      z.object({
        language: z.string(),
        voice: z.object({ model: z.string(), voiceId: z.string() }).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      languageInfo(input.language);
      const voices = { ...(await userVoiceDefaults(ctx.deps, ctx.userId)) };
      if (input.voice) {
        const choice = input.voice as unknown as VoiceChoice;
        await assertVoiceChoice(ctx.deps, ctx.userId, choice);
        voices[input.language] = voiceDefaultsSchema.parse({ [input.language]: choice })[input.language]!;
      } else delete voices[input.language];
      await ctx.deps.db
        .insert(userSettings)
        .values({ userId: ctx.userId, voices })
        .onConflictDoUpdate({ target: userSettings.userId, set: { voices, updatedAt: new Date() } });
    }),
});
