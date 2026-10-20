import { describe, expect, it } from 'vitest';
import type { ProviderId } from '@vf/shared';
import { CATALOG, createAiRegistry, createEnvCredentialStore, type CredentialStore } from './index';

const only = (...providers: ProviderId[]): CredentialStore => ({
  get: async (_u, p) => (providers.includes(p) ? `key-${p}` : null),
});
const u = 'user-1';
const openaiText = CATALOG.find((e) => e.provider === 'openai' && e.capability === 'text')!.ref;

describe('AiRegistry', () => {
  const registry = createAiRegistry({ credentials: only('anthropic') });

  it('marks only providers with keys as available and hides fake', async () => {
    const items = await registry.catalog(u);
    expect(items.filter((i) => i.provider === 'anthropic').every((i) => i.available)).toBe(true);
    expect(items.filter((i) => i.provider === 'openai' || i.provider === 'google').some((i) => i.available)).toBe(
      false,
    );
    expect(items.some((i) => i.provider === 'fake')).toBe(false);
  });

  it('rejects unknown models with MODEL_NOT_FOUND', async () => {
    await expect(registry.text(u, 'anthropic/unknown-model')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('rejects models without a key with MODEL_UNAVAILABLE', async () => {
    await expect(registry.text(u, openaiText)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('rejects a model of another capability with MODEL_NOT_FOUND', async () => {
    await expect(registry.image(u, 'anthropic/claude-sonnet-5-5')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('exposes fake models when AI_FAKE=1', async () => {
    const withFake = createAiRegistry({ credentials: createEnvCredentialStore({ AI_FAKE: '1' }) });
    const fakes = (await withFake.catalog(u)).filter((i) => i.provider === 'fake');
    expect(fakes.map((f) => f.ref).sort()).toEqual(['fake/image', 'fake/stt', 'fake/text', 'fake/tts', 'fake/video']);
    expect(fakes.every((f) => f.available)).toBe(true);
  });

  it('returns real image adapters for providers with keys', async () => {
    const reg = createAiRegistry({ credentials: only('openai', 'google') });
    const openaiImage = CATALOG.find((e) => e.provider === 'openai' && e.capability === 'image')!.ref;
    const googleImage = CATALOG.find((e) => e.provider === 'google' && e.capability === 'image')!.ref;
    expect(typeof (await reg.image(u, openaiImage)).generate).toBe('function');
    expect(typeof (await reg.image(u, googleImage)).generate).toBe('function');
    await expect(registry.image(u, openaiImage)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('image and video catalog entries declare aspects, and video entries are priced per second', () => {
    for (const e of CATALOG.filter((x) => x.capability === 'image' || x.capability === 'video')) {
      expect(e.aspects?.length, e.ref).toBeGreaterThan(0);
    }
    for (const e of CATALOG.filter((x) => x.capability === 'video' && x.provider !== 'fake')) {
      expect(e.pricing?.[0]?.unit, e.ref).toBe('second');
    }
  });
});
