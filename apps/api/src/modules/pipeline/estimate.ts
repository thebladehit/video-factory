import { estimateCost, scenePlan, type CatalogEntry } from '@vf/ai';
import type { ModelRef, PipelineSettings } from '@vf/shared';

/** Оцінка токенів: слів → токенів (кирилиця дорожча за англійську — беремо з запасом) */
const TOKENS_PER_WORD = 2;
/** Системний промпт і інструкції одного запиту сценарію/перекладу */
const PROMPT_TOKENS = 1500;
/** visualPrompt + keywords однієї сцени у відповіді */
const SCENE_EXTRA_TOKENS = 60;
/** Розділ плану 16:9 (≈150 с) — окремий запит сцен */
const SECTION_SEC = 150;
/** Модель міток слів, якщо TTS їх не дає (як `STT_MODEL` студії) */
const WHISPER = 'openai/whisper-1' as ModelRef;

export interface PipelineEstimate {
  /** null — у якоїсь моделі немає ціни */
  usd: number | null;
  parts: {
    script: number | null;
    images: number | null;
    tts: number | null;
    stt: number | null;
    translate: number | null;
  };
}

type Usage = Parameters<typeof estimateCost>[1];

/** Чиста оцінка вартості запуску (верхня межа: кожна сцена генерує фото). */
export function estimatePipeline(s: PipelineSettings, catalog: readonly CatalogEntry[]): PipelineEstimate {
  const cost = (ref: ModelRef, u: Usage): number | null => {
    const entry = catalog.find((e) => e.ref === ref);
    return entry ? estimateCost(entry, u) : null;
  };
  const sum = (xs: (number | null)[]): number | null =>
    xs.some((x) => x === null) ? null : xs.reduce<number>((a, x) => a + x!, 0);

  const plan = scenePlan(s.format, s.targetSec);
  const textTokens = plan.words * TOKENS_PER_WORD;
  const requests = plan.twoStage ? 1 + Math.ceil(s.targetSec / SECTION_SEC) : 1;
  const script = cost(s.textModel, {
    inputTokens: PROMPT_TOKENS * requests,
    outputTokens: textTokens + plan.scenes * SCENE_EXTRA_TOKENS,
  });
  const images = cost(s.imageModel, { images: plan.scenes });

  // сценарій пишеться під targetSec: символи озвучки ≈ targetSec × 15, тож символи / 15 = targetSec на мову
  const durationSec = s.targetSec;
  const tts = sum(s.languages.map((l) => (s.voices[l] ? cost(s.voices[l].model, { durationSec }) : null)));
  const stt = sum(
    s.languages.map((l) => {
      const entry = catalog.find((e) => e.ref === s.voices[l]?.model);
      return entry?.wordTimestamps ? 0 : cost(WHISPER, { durationSec });
    }),
  );
  const translate = sum(
    s.languages
      .filter((l) => l !== s.baseLanguage)
      .map(() => cost(s.textModel, { inputTokens: PROMPT_TOKENS + textTokens, outputTokens: textTokens })),
  );

  const parts = { script, images, tts, stt, translate };
  return { usd: sum(Object.values(parts)), parts };
}
