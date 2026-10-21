import { describe, expect, it } from 'vitest';
import { silentWav } from '../fake/wav';
import { createOpenAiTts } from './openai-speech';

function mock(status = 200, body: Uint8Array | string = silentWav(1000)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const tts = (f: typeof fetch) => createOpenAiTts({ apiKey: 'k', model: 'gpt-4o-mini-tts', fetch: f, retryDelayMs: 1 });

describe('OpenAI TTS', () => {
  it('posts to /v1/audio/speech with wav output and returns a wav with duration', async () => {
    const { fn, calls } = mock();
    const res = await tts(fn).synthesize({ text: 'Привіт', voiceId: 'marin', language: 'uk', instructions: 'тепло' });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      input: 'Привіт',
      instructions: 'тепло',
      response_format: 'wav',
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(res.audio.mime).toBe('audio/wav');
    expect(res.audio.durationMs).toBe(1000);
    expect(res.words).toBeUndefined();
  });

  it('rejects text over 1500 chars before calling the provider', async () => {
    const { fn, calls } = mock();
    await expect(
      tts(fn).synthesize({ text: 'a'.repeat(1501), voiceId: 'marin', language: 'uk' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(calls).toHaveLength(0);
  });

  it('retries 429 then succeeds', async () => {
    let n = 0;
    const f = (async () =>
      ++n < 3 ? new Response('{}', { status: 429 }) : new Response(silentWav(500))) as unknown as typeof fetch;
    const res = await tts(f).synthesize({ text: 'x', voiceId: 'marin', language: 'uk' });
    expect(n).toBe(3);
    expect(res.audio.durationMs).toBe(500);
  });

  it('maps a 400 to PROVIDER_ERROR without retry', async () => {
    const { fn, calls } = mock(400, JSON.stringify({ error: { message: 'bad voice' } }));
    await expect(tts(fn).synthesize({ text: 'x', voiceId: 'zzz', language: 'uk' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('bad voice'),
    });
    expect(calls).toHaveLength(1);
  });
});
