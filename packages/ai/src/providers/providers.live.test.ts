import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  buildScriptPrompt,
  createAiRegistry,
  createEnvCredentialStore,
  scenePlan,
  scriptSchema,
  taggerPrompt,
  taggerSchema,
  validateScript,
} from '../index';

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

const available = async (ref: string) => !!(await registry.catalog('live')).find((i) => i.ref === ref)?.available;

describe('live speech providers', () => {
  const ttsModels = CATALOG.filter((e) => e.capability === 'tts' && e.provider !== 'fake');
  it.each(ttsModels.map((e) => [e.ref, e] as const))(
    '%s synthesizes a WAV',
    async (_ref, entry) => {
      if (!(await available(entry.ref))) return;
      const { audio } = await (
        await registry.tts('live', entry.ref)
      ).synthesize({ text: 'Привіт, це перевірка озвучки.', voiceId: entry.voices![0]!.id, language: 'uk' });
      expect(audio.mime).toBe('audio/wav');
      expect(audio.durationMs).toBeGreaterThan(0);
    },
    120_000,
  );

  it('whisper-1 returns word timestamps for generated speech', async () => {
    const tts = ttsModels.find((e) => e.provider === 'openai');
    if (!tts || !(await available('openai/whisper-1')) || !(await available(tts.ref))) return;
    const { audio } = await (
      await registry.tts('live', tts.ref)
    ).synthesize({ text: 'Hello there, this is a short test.', voiceId: 'marin', language: 'en' });
    const res = await (
      await registry.stt('live', 'openai/whisper-1')
    ).transcribe({ audio: audio.bytes, mime: audio.mime });
    expect(res.words!.length).toBeGreaterThan(0);
    expect(res.words![0]!.endMs).toBeGreaterThan(res.words![0]!.startMs);
  }, 120_000);

  it('gemini stt returns at least one segment', async () => {
    const tts = ttsModels.find((e) => e.provider === 'google');
    if (!tts || !(await available('google/gemini-3.8-flash')) || !(await available(tts.ref))) return;
    const { audio } = await (
      await registry.tts('live', tts.ref)
    ).synthesize({ text: 'Hello there, this is a short test.', voiceId: 'Kore', language: 'en' });
    const res = await (
      await registry.stt('live', 'google/gemini-3.8-flash')
    ).transcribe({ audio: audio.bytes, mime: audio.mime });
    expect(res.segments.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe('live script generation', () => {
  it.each(textModels.filter((e) => e.cheap).map((e) => [e.ref, e] as const))(
    '%s script returns a valid object within ±30 % of the word budget',
    async (_ref, entry) => {
      if (!(await available(entry.ref))) return;
      const plan = scenePlan('9:16', 45);
      const { system, prompt } = buildScriptPrompt({
        topic: 'Чому небо блакитне',
        format: '9:16',
        targetSec: 45,
        language: 'uk',
        channelStyle: '',
        style: '',
      });
      const script = await (await registry.text('live', entry.ref)).generateObject(scriptSchema, { system, prompt });
      expect(validateScript(script, plan)).toEqual([]);
      const words = script.scenes.reduce((n, s) => n + s.narration.split(/\s+/).filter(Boolean).length, 0);
      expect(words).toBeGreaterThan(plan.words * 0.7);
      expect(words).toBeLessThan(plan.words * 1.3);
    },
    120_000,
  );
});
