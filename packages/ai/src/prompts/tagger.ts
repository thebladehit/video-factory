import { z } from 'zod';

/** Промпт для тегів; зміна тексту = нова версія (пишеться в generations.prompt) */
export const TAGGER_PROMPT_VERSION = 1;

export const taggerSchema = z.object({
  title: z.string().min(1).max(120),
  tags: z.array(z.string().min(1).max(40)).min(5).max(10),
});
export type TaggerResult = z.infer<typeof taggerSchema>;

const SYSTEM = [
  'Ти допомагаєш упорядкувати медіабібліотеку відеостудії.',
  'Поверни коротку назву (до 8 слів) і 5–10 тегів для пошуку.',
  'Теги — окремі слова або короткі фрази в нижньому регістрі: обʼєкти, дії, місце, настрій, стиль, кольори.',
  'Пиши українською; для 2–3 головних сутностей додай англійський синонім окремим тегом (напр. «кіт» і «cat»).',
].join(' ');

export function taggerPrompt(i: { mode: 'image' | 'prompt'; prompt?: string }): { system: string; prompt: string } {
  if (i.mode === 'image') return { system: SYSTEM, prompt: 'Опиши це зображення назвою й тегами.' };
  return { system: SYSTEM, prompt: `Зображення згенеровано за описом:\n${i.prompt ?? ''}\nДай назву й теги.` };
}
