import { z } from 'zod';
import { PROVIDER_IDS, type ModelRef } from './capabilities';

const modelRefSchema = z
  .string()
  .refine((s) => {
    const i = s.indexOf('/');
    return i > 0 && i < s.length - 1 && (PROVIDER_IDS as readonly string[]).includes(s.slice(0, i));
  }, 'Некоректне посилання на модель')
  .transform((s) => s as ModelRef);

const voiceChoiceSchema = z.object({
  model: modelRefSchema,
  voiceId: z.string().min(1),
  instructions: z.string().optional(),
});
export type VoiceChoice = z.output<typeof voiceChoiceSchema>;

export const DEFAULT_ORIGINAL = { mode: 'duck', level: 0.25, duckLevel: 0.08 } as const;

const originalSoundSchema = z.object({
  mode: z.enum(['replace', 'duck']),
  level: z.number().finite().min(0).max(2),
  duckLevel: z.number().finite().min(0).max(2),
});
export type OriginalSound = z.output<typeof originalSoundSchema>;

export const projectVoiceSchema = z.object({
  languages: z
    .record(
      z.string(),
      z.object({
        voice: voiceChoiceSchema.optional(),
        captions: z.object({ enabled: z.boolean(), styleId: z.string().min(1) }),
      }),
    )
    .default({}),
  original: originalSoundSchema.default({ ...DEFAULT_ORIGINAL }),
});
export type ProjectVoice = z.output<typeof projectVoiceSchema>;

export const voiceDefaultsSchema = z.record(
  z.string(),
  z.object({ model: modelRefSchema, voiceId: z.string().min(1) }),
);
export type VoiceDefaults = z.output<typeof voiceDefaultsSchema>;
