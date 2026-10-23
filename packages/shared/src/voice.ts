import { z } from 'zod';
import { PROVIDER_IDS, type ModelRef } from './capabilities';

export const modelRefSchema = z
  .string()
  .refine((s) => {
    const i = s.indexOf('/');
    return i > 0 && i < s.length - 1 && (PROVIDER_IDS as readonly string[]).includes(s.slice(0, i));
  }, 'Некоректне посилання на модель')
  .transform((s) => s as ModelRef);

export const voiceChoiceSchema = z.object({
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
  z.object({ model: modelRefSchema, voiceId: z.string().min(1), instructions: z.string().max(1000).optional() }),
);
export type VoiceDefaults = z.output<typeof voiceDefaultsSchema>;

/** Типова подача озвучки: рівний нейтральний диктор, щоб дубли одного відео звучали однаково. */
export const DEFAULT_DELIVERY: Record<string, string> = {
  uk: 'Рівний спокійний голос оповідача. Помірний сталий темп, нейтральна впевнена інтонація, однакова гучність. Без драматизму, шепоту, сміху й різких пауз.',
  en: 'Steady, calm narrator voice. Moderate consistent pace, neutral confident intonation, even volume. No drama, whispering, laughter or abrupt pauses.',
};

export function deliveryFor(language: string): string {
  return DEFAULT_DELIVERY[language] ?? DEFAULT_DELIVERY.en!;
}
