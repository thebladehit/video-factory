import { describe, expect, it } from 'vitest';
import { createWhisperStt } from './whisper';

function mock(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const verbose = {
  text: 'Hello world again',
  language: 'english',
  duration: 3,
  segments: [
    { id: 0, start: 0, end: 1.5, text: ' Hello world' },
    { id: 1, start: 2, end: 3, text: ' again' },
  ],
  words: [
    { word: 'Hello', start: 0, end: 0.5 },
    { word: 'world', start: 0.6, end: 1.5 },
    { word: 'again', start: 2, end: 3 },
  ],
};

describe('whisper STT', () => {
  it('sends multipart verbose_json with word+segment granularities and maps seconds → ms for words', async () => {
    const { fn, calls } = mock(verbose);
    const stt = createWhisperStt({ apiKey: 'k', model: 'whisper-1', fetch: fn, retryDelayMs: 1 });
    const res = await stt.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      mime: 'audio/wav',
      language: 'en',
      prompt: 'ctx',
    });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    const form = calls[0]!.init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('ctx');
    expect((form.get('file') as File).type).toBe('audio/wav');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(res.text).toBe('Hello world again');
    expect(res.language).toBe('english');
    expect(res.segments).toEqual([
      { start: 0, end: 1.5, text: 'Hello world' },
      { start: 2, end: 3, text: 'again' },
    ]);
    expect(res.words).toEqual([
      { text: 'Hello', startMs: 0, endMs: 500 },
      { text: 'world', startMs: 600, endMs: 1500 },
      { text: 'again', startMs: 2000, endMs: 3000 },
    ]);
  });

  it('works without words/segments in the response', async () => {
    const { fn } = mock({ text: 'hi' });
    const stt = createWhisperStt({ apiKey: 'k', model: 'whisper-1', fetch: fn, retryDelayMs: 1 });
    expect(await stt.transcribe({ audio: new Uint8Array(1), mime: 'audio/mpeg' })).toMatchObject({
      text: 'hi',
      segments: [],
    });
  });

  it('retries 429', async () => {
    let n = 0;
    const f = (async () =>
      ++n < 2 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify(verbose))) as unknown as typeof fetch;
    await createWhisperStt({ apiKey: 'k', model: 'whisper-1', fetch: f, retryDelayMs: 1 }).transcribe({
      audio: new Uint8Array(1),
      mime: 'audio/wav',
    });
    expect(n).toBe(2);
  });
});
