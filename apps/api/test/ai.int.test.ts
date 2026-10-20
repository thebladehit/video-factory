import { describe, expect, it } from 'vitest';
import { AppError } from '@vf/shared';
import type { AiRegistry } from '@vf/ai';
import { startApp } from './helpers';

describe('ai', () => {
  it('catalog includes the fake text model', async () => {
    const { caller } = await startApp();
    expect(await caller.ai.catalog()).toContainEqual(expect.objectContaining({ ref: 'fake/text', available: true }));
  });

  it('testModel returns a sample', async () => {
    const { caller } = await startApp();
    const res = await caller.ai.testModel({ ref: 'fake/text' });
    expect(res.sample).not.toBe('');
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  it('exposes provider errors over HTTP with appCode', async () => {
    const failingAi = {
      text: async () => ({
        generateText: async () => {
          throw new AppError('PROVIDER_ERROR', 'anthropic: 401 invalid x-api-key', {
            provider: 'anthropic',
            status: 401,
          });
        },
      }),
    } as unknown as AiRegistry;
    const { server } = await startApp({}, { ai: failingAi });
    const res = await server.inject({
      method: 'POST',
      url: '/trpc/ai.testModel',
      payload: { ref: 'anthropic/claude-sonnet-5-5' },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error.message).toContain('invalid x-api-key');
    expect(body.error.data.appCode).toBe('PROVIDER_ERROR');
  });
});
