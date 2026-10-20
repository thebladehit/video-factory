import { describe, expect, it } from 'vitest';
import { CATALOG, createAiRegistry, createEnvCredentialStore } from '../index';

// Справжні виклики API. Запуск лише вручну: pnpm test:live
const registry = createAiRegistry({ credentials: createEnvCredentialStore(process.env) });
const textModels = CATALOG.filter((e) => e.capability === 'text' && e.provider !== 'fake');

describe('live text providers', () => {
  it.each(textModels.map((e) => [e.ref, e] as const))('%s answers', async (_ref, entry) => {
    const available = (await registry.catalog('live')).find((i) => i.ref === entry.ref)?.available;
    if (!available) return; // немає ключа — пропускаємо
    const text = await (await registry.text('live', entry.ref)).generateText({
      prompt: 'Відповідай одним словом: ок',
      maxOutputTokens: 10,
    });
    expect(text.trim()).not.toBe('');
  }, 60_000);
});
