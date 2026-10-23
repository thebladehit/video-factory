import { describe, expect, it } from 'vitest';
import { silentWav } from '../fake/wav';
import { createGeminiTts } from './google-speech';

function mock(parts: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(status === 200 ? { steps: [{ type: 'model_output', content: parts }] } : parts), {
      status,
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const tts = (f: typeof fetch) =>
  createGeminiTts({ apiKey: 'k', model: 'gemini-3.8-flash-tts', fetch: f, retryDelayMs: 1 });

describe('Gemini TTS', () => {
  it('sends an Interactions request: verbatim text, style as speech_metadata, voice; wraps PCM into a 24 kHz WAV', async () => {
    const pcm = Buffer.alloc(48000); // 1 s at 24 kHz mono 16-bit
    const { fn, calls } = mock([
      { type: 'audio', mime_type: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') },
    ]);
    const res = await tts(fn).synthesize({ text: 'Привіт', voiceId: 'Kore', language: 'uk', instructions: 'cheerful' });
    expect(calls[0]!.url).toMatch(/\/v1beta\/interactions$/);
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe('gemini-3.8-flash-tts');
    expect(body.response_format).toEqual({ type: 'audio' });
    expect(body.generation_config.speech_config).toEqual([{ voice: 'Kore' }]);
    expect(body.generation_config.temperature).toBe(0.4);
    // текст — дослівний транскрипт: стиль не потрапляє в нього, інакше модель читає його вголос
    expect(body.input[0].content[0]).toEqual({
      type: 'text',
      text: 'Привіт',
      annotations: [{ type: 'speech_metadata', style: 'cheerful' }],
    });
    const wav = Buffer.from(res.audio.bytes);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(48000);
    expect(res.audio).toMatchObject({ mime: 'audio/wav', durationMs: 1000 });
  });

  it('passes a ready WAV through unchanged', async () => {
    const wav = silentWav(500);
    const { fn } = mock([{ type: 'audio', mime_type: 'audio/wav', data: Buffer.from(wav).toString('base64') }]);
    const res = await tts(fn).synthesize({ text: 'x', voiceId: 'Kore', language: 'uk' });
    expect(Buffer.from(res.audio.bytes).equals(Buffer.from(wav))).toBe(true);
    expect(res.audio.durationMs).toBe(500);
  });

  it('text without instructions is sent without annotations', async () => {
    const { fn, calls } = mock([
      { type: 'audio', mime_type: 'audio/L16;rate=24000', data: Buffer.alloc(480).toString('base64') },
    ]);
    await tts(fn).synthesize({ text: 'просто', voiceId: 'Kore', language: 'uk' });
    expect(JSON.parse(calls[0]!.init.body as string).input[0].content[0]).toEqual({ type: 'text', text: 'просто' });
  });

  it('errors when no audio is returned', async () => {
    const { fn } = mock([{ type: 'text', text: 'refused' }]);
    await expect(tts(fn).synthesize({ text: 'x', voiceId: 'Kore', language: 'uk' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('rejects text over 1500 chars, retries 429', async () => {
    const { fn, calls } = mock([]);
    await expect(tts(fn).synthesize({ text: 'a'.repeat(1501), voiceId: 'Kore', language: 'uk' })).rejects.toMatchObject(
      {
        code: 'VALIDATION',
      },
    );
    expect(calls).toHaveLength(0);
    let n = 0;
    const f = (async () =>
      ++n < 2
        ? new Response('{}', { status: 429 })
        : new Response(
            JSON.stringify({
              steps: [
                {
                  type: 'model_output',
                  content: [{ type: 'audio', mime_type: 'audio/L16;rate=24000', data: Buffer.alloc(480).toString('base64') }],
                },
              ],
            }),
          )) as unknown as typeof fetch;
    await tts(f).synthesize({ text: 'x', voiceId: 'Kore', language: 'uk' });
    expect(n).toBe(2);
  });
});
