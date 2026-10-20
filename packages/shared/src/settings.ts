import { CAPABILITIES } from './capabilities';

/** Моделі за замовчуванням: можливості + окрема модель для тегів (текстова) */
export const DEFAULT_SLOTS = [...CAPABILITIES, 'tagger'] as const;
export type DefaultSlot = (typeof DEFAULT_SLOTS)[number];
