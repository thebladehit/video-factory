import { z } from 'zod';
import type { ModelRef } from './capabilities';
import { LANGUAGES } from './languages';
import type { VideoFormat } from './timeline';
import { modelRefSchema, voiceChoiceSchema, type VoiceChoice } from './voice';

export const PIPELINE_STAGES = ['script', 'review', 'produce', 'assemble', 'done'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export const PIPELINE_STATUSES = ['running', 'awaiting_review', 'done', 'failed', 'cancelled'] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
export const SCENE_STATUSES = ['empty', 'queued', 'running', 'ready', 'failed'] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];
export const VISUAL_SOURCES = ['library', 'generated', 'manual'] as const;
export type VisualSource = (typeof VISUAL_SOURCES)[number];

/** Межі й значення за замовчуванням тривалості сценарію (секунди) */
export const TARGET_SEC: Record<VideoFormat, { min: number; max: number; default: number }> = {
  '9:16': { min: 15, max: 90, default: 45 },
  '16:9': { min: 60, max: 900, default: 300 },
};

const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

export const pipelineSettingsSchema = z
  .object({
    topic: z.string().min(3).max(2000),
    format: z.enum(['9:16', '16:9']),
    targetSec: z.number().int(),
    style: z.string().max(1000),
    baseLanguage: z.string().min(1),
    languages: z.array(z.string().min(1)).min(1),
    textModel: modelRefSchema,
    imageModel: modelRefSchema,
    voices: z.record(z.string(), voiceChoiceSchema),
    musicAssetId: z.string().uuid().nullable(),
    stopAfterScript: z.boolean(),
  })
  .superRefine((s, ctx) => {
    const { min, max } = TARGET_SEC[s.format];
    if (s.targetSec < min || s.targetSec > max) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetSec'],
        message: `Тривалість для ${s.format}: ${min}–${max} с`,
      });
    }
    if (!s.languages.includes(s.baseLanguage)) {
      ctx.addIssue({ code: 'custom', path: ['baseLanguage'], message: 'Базова мова має бути серед мов відео' });
    }
    for (const code of s.languages) {
      if (!LANGUAGE_CODES.has(code)) {
        ctx.addIssue({ code: 'custom', path: ['languages'], message: `Невідома мова: "${code}"` });
      }
      if (!s.voices[code]) {
        ctx.addIssue({ code: 'custom', path: ['voices', code], message: `Не вибрано голос для мови "${code}"` });
      }
    }
  });
export type PipelineSettings = z.output<typeof pipelineSettingsSchema>;

/** Початкові налаштування форми: тема тощо лишаються користувачеві */
export function defaultPipelineSettings(
  format: VideoFormat,
  defaults: { text?: ModelRef; image?: ModelRef; voices: Record<string, VoiceChoice> },
): Partial<PipelineSettings> {
  return {
    format,
    targetSec: TARGET_SEC[format].default,
    stopAfterScript: format === '16:9',
    style: '',
    musicAssetId: null,
    ...(defaults.text ? { textModel: defaults.text } : {}),
    ...(defaults.image ? { imageModel: defaults.image } : {}),
    voices: defaults.voices,
  };
}
