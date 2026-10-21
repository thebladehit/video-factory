import { z } from 'zod';
import type { STT, TextGen } from '../types';

export const sttSchema = z.object({
  language: z.string().optional(),
  segments: z.array(z.object({ start: z.number().min(0), end: z.number().min(0), text: z.string() })),
});

const SYSTEM =
  'Ти точно розпізнаєш мову з аудіо. Поверни фрази в порядку звучання з часом початку й кінця в секундах (з точністю до десятої). ' +
  'Не додавай пояснень і не перекладай; пропускай тишу й шум.';

/** Запасний STT на Gemini: лише сегменти (слів немає). */
export function createGeminiStt(textGen: TextGen): STT {
  return {
    async transcribe({ audio, mime, language, prompt, signal }) {
      const hint = [
        language ? `Мова аудіо: ${language}.` : 'Визнач мову аудіо.',
        prompt ? `Контекст і терміни: ${prompt}` : '',
        'Розпізнай мову й розбий на фрази.',
      ]
        .filter(Boolean)
        .join('\n');
      const res = await textGen.generateObject(sttSchema, {
        system: SYSTEM,
        prompt: hint,
        images: [{ bytes: audio, mime }],
        signal,
      });
      const segments = res.segments.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
      return { text: segments.map((s) => s.text).join(' '), language: res.language ?? language, segments };
    },
  };
}
