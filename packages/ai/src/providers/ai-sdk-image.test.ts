import { APICallError } from 'ai';
import { MockImageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../catalog';
import { createAiSdkImageGen } from './ai-sdk-image';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const entry = (extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  ref: 'google/img',
  provider: 'google',
  capability: 'image',
  label: 'img',
  aspects: ['9:16', '16:9', '1:1'],
  maxN: 4,
  ...extra,
});

type Opts = Parameters<MockImageModelV4['doGenerate']>[0];
const recording = () => {
  const calls: Opts[] = [];
  const model = new MockImageModelV4({
    maxImagesPerCall: 4,
    doGenerate: async (o) => {
      calls.push(o);
      return {
        images: Array.from({ length: o.n }, () => PNG),
        warnings: [],
        response: { timestamp: new Date(), modelId: 'img', headers: undefined },
      };
    },
  });
  return { model, calls };
};

const failing = (statusCode: number, message: string) => {
  let calls = 0;
  const model = new MockImageModelV4({
    doGenerate: async () => {
      calls++;
      throw new APICallError({
        message,
        url: 'https://x',
        requestBodyValues: {},
        statusCode,
        isRetryable: statusCode >= 500,
      });
    },
  });
  return { model, calls: () => calls };
};

describe('createAiSdkImageGen', () => {
  it('passes aspectRatio for models without sizes', async () => {
    const { model, calls } = recording();
    await createAiSdkImageGen('google', model, entry()).generate({ prompt: 'кіт', aspect: '9:16', n: 1 });
    expect(calls[0]!.aspectRatio).toBe('9:16');
    expect(calls[0]!.size).toBeUndefined();
  });

  it('passes size from catalog when present', async () => {
    const { model, calls } = recording();
    const e = entry({ provider: 'openai', sizes: { '9:16': '1024x1536', '16:9': '1536x1024', '1:1': '1024x1024' } });
    await createAiSdkImageGen('openai', model, e).generate({ prompt: 'кіт', aspect: '9:16', n: 1 });
    expect(calls[0]!.size).toBe('1024x1536');
    expect(calls[0]!.aspectRatio).toBeUndefined();
  });

  it('returns n files with mime', async () => {
    const { model } = recording();
    const files = await createAiSdkImageGen('google', model, entry()).generate({ prompt: 'кіт', aspect: '1:1', n: 3 });
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ mime: 'image/png' });
    expect(files[0]!.bytes).toEqual(PNG);
  });

  it('maps a content policy refusal to PROVIDER_ERROR without retry', async () => {
    const { model, calls } = failing(400, 'Your request was rejected by the safety system');
    await expect(
      createAiSdkImageGen('openai', model, entry()).generate({ prompt: 'x', aspect: '1:1', n: 1 }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('safety system'),
      details: { provider: 'openai', status: 400 },
    });
    expect(calls()).toBe(1);
  });

  it('retries 500 errors', async () => {
    const { model, calls } = failing(500, 'internal');
    await expect(
      createAiSdkImageGen('google', model, entry()).generate({ prompt: 'x', aspect: '1:1', n: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(calls()).toBe(3);
  }, 20_000);
});
