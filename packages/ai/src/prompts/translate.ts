import { z } from 'zod';

/** Fake-провайдер розбирає рядок «Цільова мова: …» і JSON-рядки фраз — змінюючи формат, оновіть fake/index.ts */
export const translateSchema = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string() })),
});

export function buildTranslatePrompt(req: {
  from: string;
  to: string;
  items: { id: string; text: string }[];
  context?: string[];
}): { system: string; prompt: string } {
  const system = [
    `Ти перекладач для озвучки відео: переклади з мови «${req.from}» на мову «${req.to}».`,
    'Пиши природною мовою, якою це сказав би диктор; без пояснень, приміток і лапок навколо.',
    'Довжина перекладу близька до оригіналу (озвучка має вкластись у той самий час).',
    'Терміни й імена перекладай узгоджено в усіх фразах. Поверни кожен id рівно один раз, зберігши його без змін.',
  ].join(' ');
  const context = req.context?.length
    ? `Попередній контекст (уже перекладені фрази, лише для узгодженості термінів):\n${req.context.map((c) => `- ${c}`).join('\n')}\n\n`
    : '';
  const items = req.items.map((i) => JSON.stringify({ id: i.id, text: i.text })).join('\n');
  return {
    system,
    prompt: `Цільова мова: ${req.to}\n${context}Фрази для перекладу (по одній у рядку, JSON):\n${items}`,
  };
}
