import { describe, expect, it } from 'vitest';
import { CATALOG, type CatalogEntry } from '@vf/ai';
import type { ModelRef, PipelineSettings } from '@vf/shared';
import { estimatePipeline } from './estimate';

const settings = (over: Partial<PipelineSettings> = {}): PipelineSettings => ({
  topic: 'Як працюють чорні діри',
  format: '9:16',
  targetSec: 45,
  style: '',
  baseLanguage: 'uk',
  languages: ['uk', 'en'],
  textModel: 'fake/text' as ModelRef,
  imageModel: 'fake/image' as ModelRef,
  voices: {
    uk: { model: 'fake/tts' as ModelRef, voiceId: 'fake-voice' },
    en: { model: 'fake/tts' as ModelRef, voiceId: 'fake-voice' },
  },
  musicAssetId: null,
  stopAfterScript: false,
  ...over,
});

describe('estimatePipeline', () => {
  it('9:16 45 s, uk+en, fake models → all parts 0', () => {
    const e = estimatePipeline(settings(), CATALOG);
    expect(e).toEqual({ usd: 0, parts: { script: 0, images: 0, tts: 0, stt: 0, translate: 0 } });
  });

  it('openai tts priced by minutes × languages (+ whisper for words, TTS has no timestamps)', () => {
    const voice = { model: 'openai/gpt-4o-mini-tts' as ModelRef, voiceId: 'alloy' };
    const e = estimatePipeline(settings({ voices: { uk: voice, en: voice } }), CATALOG);
    // 45 с тексту на мову (символи / 15), 2 мови
    expect(e.parts.tts).toBeCloseTo(((0.015 * 45) / 60) * 2, 9);
    expect(e.parts.stt).toBeCloseTo(((0.006 * 45) / 60) * 2, 9);
    expect(e.usd).toBeCloseTo(e.parts.tts! + e.parts.stt!, 9);
  });

  it('images: every scene generated (upper bound)', () => {
    const e = estimatePipeline(settings({ imageModel: 'openai/gpt-image-2' as ModelRef }), CATALOG);
    // 45 / 5 = 9 сцен
    expect(e.parts.images).toBeCloseTo(9 * 0.04, 9);
  });

  it('script and translate priced by tokens of the text model', () => {
    const e = estimatePipeline(settings({ textModel: 'anthropic/claude-haiku-5-5' as ModelRef }), CATALOG);
    expect(e.parts.script).toBeGreaterThan(0);
    expect(e.parts.translate).toBeGreaterThan(0);
    const mono = estimatePipeline(
      settings({ textModel: 'anthropic/claude-haiku-5-5' as ModelRef, languages: ['uk'] }),
      CATALOG,
    );
    expect(mono.parts.translate).toBe(0);
  });

  it('missing price → usd null', () => {
    const catalog: CatalogEntry[] = CATALOG.map((c) => (c.ref === 'fake/image' ? { ...c, pricing: undefined } : c));
    const e = estimatePipeline(settings(), catalog);
    expect(e.parts.images).toBeNull();
    expect(e.usd).toBeNull();
  });

  it('unknown model → its part null', () => {
    const e = estimatePipeline(settings({ textModel: 'fake/nope' as ModelRef }), CATALOG);
    expect(e.parts.script).toBeNull();
    expect(e.usd).toBeNull();
  });
});
