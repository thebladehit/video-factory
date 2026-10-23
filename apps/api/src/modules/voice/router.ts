import { z } from 'zod';
import type { ModelRef, OriginalSound, VoiceChoice } from '@vf/shared';
import { procedure, router } from '../../trpc';
import { getLocalized, languageSubtitles, separateLanguage, unseparateLanguage } from './localized';
import {
  audition,
  createFromAsset,
  enqueueSynthesize,
  enqueueTranscribe,
  enqueueTranslate,
  getVoice,
  listVoiceProjects,
  previewVoice,
  setCaptions,
  setLanguages,
  setOriginal,
  setText,
  setVoiceChoice,
} from './service';

const projectId = z.string();
const language = z.string();
// точну перевірку (модель, голос, межі) роблять сервіси — помилки VALIDATION/MODEL_NOT_FOUND українською
export const voiceChoiceInput = z.object({
  model: z.string(),
  voiceId: z.string(),
  instructions: z.string().max(1000).optional(),
}) as unknown as z.ZodType<VoiceChoice>;
const original = z.object({
  mode: z.enum(['replace', 'duck']),
  level: z.number(),
  duckLevel: z.number(),
}) as z.ZodType<OriginalSound>;

export const voiceRouter = router({
  list: procedure.query(({ ctx }) => listVoiceProjects(ctx.deps, ctx.userId)),
  get: procedure
    .input(z.object({ projectId }))
    .query(({ ctx, input }) => getVoice(ctx.deps, ctx.userId, input.projectId)),
  createFromAsset: procedure
    .input(z.object({ assetId: z.string() }))
    .mutation(({ ctx, input }) => createFromAsset(ctx.deps, ctx.userId, input.assetId)),
  setLanguages: procedure
    .input(z.object({ projectId, base: language, languages: z.array(language).min(1).max(20) }))
    .mutation(({ ctx, input }) => setLanguages(ctx.deps, ctx.userId, input)),
  setVoice: procedure
    .input(z.object({ projectId, language, voice: voiceChoiceInput.nullable() }))
    .mutation(({ ctx, input }) => setVoiceChoice(ctx.deps, ctx.userId, input)),
  setOriginal: procedure
    .input(z.object({ projectId, original }))
    .mutation(({ ctx, input }) => setOriginal(ctx.deps, ctx.userId, input)),
  setCaptions: procedure
    .input(z.object({ projectId, language, enabled: z.boolean(), styleId: z.string() }))
    .mutation(({ ctx, input }) => setCaptions(ctx.deps, ctx.userId, input)),
  setText: procedure
    .input(z.object({ projectId, segmentId: z.string(), language, text: z.string() }))
    .mutation(({ ctx, input }) => setText(ctx.deps, ctx.userId, input)),
  transcribe: procedure
    .input(z.object({ projectId, language: language.optional() }))
    .mutation(({ ctx, input }) => enqueueTranscribe(ctx.deps, ctx.userId, input)),
  translate: procedure
    .input(z.object({ projectId, language, segmentIds: z.array(z.string()).max(5000).optional() }))
    .mutation(({ ctx, input }) => enqueueTranslate(ctx.deps, ctx.userId, input)),
  synthesize: procedure
    .input(z.object({ projectId, language: language.optional(), segmentIds: z.array(z.string()).max(5000).optional() }))
    .mutation(({ ctx, input }) => enqueueSynthesize(ctx.deps, ctx.userId, input)),
  preview: procedure
    .input(z.object({ model: z.string(), voiceId: z.string(), language }))
    .mutation(({ ctx, input }) => previewVoice(ctx.deps, ctx.userId, { ...input, model: input.model as ModelRef })),
  audition: procedure
    .input(
      z.object({
        model: z.string(),
        voiceId: z.string(),
        language,
        text: z.string().min(1).max(300),
        instructions: z.string().max(1000).optional(),
        take: z.union([z.literal(1), z.literal(2)]),
      }),
    )
    .mutation(({ ctx, input }) => audition(ctx.deps, ctx.userId, { ...input, model: input.model as ModelRef })),
  localized: procedure
    .input(z.object({ projectId, language }))
    .query(({ ctx, input }) => getLocalized(ctx.deps, ctx.userId, input)),
  separate: procedure
    .input(z.object({ projectId, language }))
    .mutation(({ ctx, input }) => separateLanguage(ctx.deps, ctx.userId, input)),
  unseparate: procedure
    .input(z.object({ projectId, language }))
    .mutation(({ ctx, input }) => unseparateLanguage(ctx.deps, ctx.userId, input)),
  subtitles: procedure
    .input(z.object({ projectId, language, format: z.enum(['srt', 'vtt']) }))
    .query(({ ctx, input }) => languageSubtitles(ctx.deps, ctx.userId, input)),
});
