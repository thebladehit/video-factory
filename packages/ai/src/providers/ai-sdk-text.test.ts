import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createAiSdkTextGen } from './ai-sdk-text';

const ok = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: 'text', text: 'ок' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }),
});

const failing = (statusCode: number, message: string) => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls++;
      throw new APICallError({ message, url: 'https://x', requestBodyValues: {}, statusCode, isRetryable: statusCode === 429 });
    },
  });
  return { model, calls: () => calls };
};

describe('createAiSdkTextGen', () => {
  it('returns model text', async () => {
    expect(await createAiSdkTextGen('anthropic', ok).generateText({ prompt: 'x' })).toBe('ок');
  });

  it('maps 401 to PROVIDER_ERROR with provider message', async () => {
    const { model } = failing(401, 'invalid x-api-key');
    await expect(createAiSdkTextGen('anthropic', model).generateText({ prompt: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('invalid x-api-key'),
      details: { provider: 'anthropic', status: 401 },
    });
  });

  it('retries 429 and then maps to PROVIDER_ERROR', async () => {
    const { model, calls } = failing(429, 'rate limited');
    await expect(createAiSdkTextGen('openai', model).generateText({ prompt: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { provider: 'openai', status: 429 },
    });
    expect(calls()).toBe(3);
  }, 20_000); // AI SDK чекає з експоненційною затримкою між ретраями
});
