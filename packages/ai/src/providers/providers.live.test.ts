import { describe, expect, it } from 'vitest';
import { CATALOG, createAiRegistry, createEnvCredentialStore, taggerPrompt, taggerSchema } from '../index';

// Справжні виклики API. Запуск лише вручну: pnpm test:live
const registry = createAiRegistry({ credentials: createEnvCredentialStore(process.env) });
const textModels = CATALOG.filter((e) => e.capability === 'text' && e.provider !== 'fake');

describe('live text providers', () => {
  it.each(textModels.map((e) => [e.ref, e] as const))(
    '%s answers',
    async (_ref, entry) => {
      const available = (await registry.catalog('live')).find((i) => i.ref === entry.ref)?.available;
      if (!available) return; // немає ключа — пропускаємо
      const text = await (
        await registry.text('live', entry.ref)
      ).generateText({
        prompt: 'Відповідай одним словом: ок',
        maxOutputTokens: 10,
      });
      expect(text.trim()).not.toBe('');
    },
    60_000,
  );
});

const cheapest = (capability: 'image' | 'video', provider: string) =>
  CATALOG.filter((e) => e.capability === capability && e.provider === provider).sort(
    (a, b) => (a.pricing?.[0]?.usd ?? 0) - (b.pricing?.[0]?.usd ?? 0),
  )[0];

describe('live image providers', () => {
  it.each(['openai', 'google'])(
    '%s generates one image with its cheapest model',
    async (provider) => {
      const entry = cheapest('image', provider);
      const available = entry && (await registry.catalog('live')).find((i) => i.ref === entry.ref)?.available;
      if (!entry || !available) return;
      const [file] = await (
        await registry.image('live', entry.ref)
      ).generate({ prompt: 'a red apple', aspect: '1:1', n: 1 });
      expect(file!.bytes.length).toBeGreaterThan(1000);
      expect(file!.mime).toMatch(/^image\//);
    },
    120_000,
  );
});

describe('live video providers', () => {
  // повна генерація коштує ~$1 — лише start + один poll, і лише з LIVE_VIDEO=1
  it.skipIf(!process.env.LIVE_VIDEO)(
    'google starts a video and reports its state',
    async () => {
      const entry = cheapest('video', 'google')!;
      const video = await registry.video('live', entry.ref);
      const ref = await video.start({ prompt: 'a red apple rotating on a table', aspect: '16:9' });
      expect(ref.data).toBeTruthy();
      const state = await video.poll(ref);
      expect(Array.isArray(state) || ['running', 'pending'].includes((state as { state: string }).state)).toBe(true);
    },
    120_000,
  );
});

describe('live vision tagger', () => {
  it.each(textModels.filter((e) => e.cheap).map((e) => [e.ref, e] as const))(
    '%s tags an image',
    async (_ref, entry) => {
      const available = (await registry.catalog('live')).find((i) => i.ref === entry.ref)?.available;
      if (!available) return;
      const fake = await createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }) }).image(
        'live',
        'fake/image',
      );
      const [img] = await fake.generate({ prompt: 'x', aspect: '1:1', n: 1 });
      const { system, prompt } = taggerPrompt({ mode: 'image' });
      const v = await (
        await registry.text('live', entry.ref)
      ).generateObject(taggerSchema, { system, prompt, images: [img!] });
      expect(taggerSchema.parse(v)).toEqual(v);
    },
    60_000,
  );
});
