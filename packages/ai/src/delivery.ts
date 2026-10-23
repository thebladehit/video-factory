// Тексти подачі живуть у @vf/shared (їх потрібна й вебу, що не залежить від @vf/ai).
export { DEFAULT_DELIVERY, deliveryFor } from '@vf/shared';

/** Нижча за типову (1.0) температура Gemini TTS — стабільніша подача між дублями. */
export const GEMINI_TTS_TEMPERATURE = 0.4;
