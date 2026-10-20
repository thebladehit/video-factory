import { describe, expect, it } from 'vitest';
import { createGeminiOmniVideoGen } from './google-omni';

const MP4 = Buffer.from('fake-mp4-bytes');

function fakeFetch(responses: { match: RegExp; method?: string; status?: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responses.find((x) => x.match.test(url) && (!x.method || x.method === (init.method ?? 'GET')));
    if (!r) throw new Error(`unexpected ${url}`);
    const status = r.status ?? 200;
    const isBytes = r.body instanceof Uint8Array;
    return new Response(isBytes ? (r.body as Uint8Array) : JSON.stringify(r.body), {
      status,
      headers: { 'content-type': isBytes ? 'video/mp4' : 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const gen = (f: typeof fetch) =>
  createGeminiOmniVideoGen({ apiKey: 'k', model: 'gemini-omni-1.1-flash', fetch: f, retryDelayMs: 1 });

describe('Gemini Omni VideoGen', () => {
  it('start sends a background interaction and returns a serializable op', async () => {
    const { fn, calls } = fakeFetch([
      { match: /\/interactions$/, method: 'POST', body: { id: 'int-1', status: 'queued' } },
    ]);
    const ref = await gen(fn).start({ prompt: 'кіт', aspect: '9:16' });
    expect(ref).toEqual({ provider: 'google', data: { id: 'int-1' } });
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({
      model: 'gemini-omni-1.1-flash',
      input: 'кіт',
      background: true,
      response_format: { type: 'video', aspect_ratio: '9:16' },
    });
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
  });

  it('poll in_progress → running', async () => {
    const { fn } = fakeFetch([{ match: /\/interactions\/int-1$/, body: { id: 'int-1', status: 'in_progress' } }]);
    expect(await gen(fn).poll({ provider: 'google', data: { id: 'int-1' } })).toEqual({ state: 'running' });
  });

  it('poll completed with inline data → mp4 file', async () => {
    const { fn } = fakeFetch([
      {
        match: /\/interactions\/int-1$/,
        body: {
          id: 'int-1',
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'video', mime_type: 'video/mp4', data: MP4.toString('base64') }],
            },
          ],
        },
      },
    ]);
    const res = await gen(fn).poll({ provider: 'google', data: { id: 'int-1' } });
    expect(Array.isArray(res)).toBe(true);
    const [file] = res as { bytes: Uint8Array; mime: string }[];
    expect(file!.mime).toBe('video/mp4');
    expect(Buffer.from(file!.bytes).toString()).toBe('fake-mp4-bytes');
  });

  it('poll completed with uri → downloads with the api key', async () => {
    const { fn, calls } = fakeFetch([
      {
        match: /\/interactions\/int-1$/,
        body: {
          id: 'int-1',
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'video', mime_type: 'video/mp4', uri: 'https://files.example/v1' }],
            },
          ],
        },
      },
      { match: /files\.example/, body: new Uint8Array(MP4) },
    ]);
    const [file] = (await gen(fn).poll({ provider: 'google', data: { id: 'int-1' } })) as { bytes: Uint8Array }[];
    expect(Buffer.from(file!.bytes).toString()).toBe('fake-mp4-bytes');
    expect((calls[1]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
  });

  it('poll failed → failed with provider text', async () => {
    const { fn } = fakeFetch([
      {
        match: /\/interactions\/int-1$/,
        body: { id: 'int-1', status: 'failed', errors: [{ message: 'blocked by safety filters' }] },
      },
    ]);
    expect(await gen(fn).poll({ provider: 'google', data: { id: 'int-1' } })).toEqual({
      state: 'failed',
      error: 'blocked by safety filters',
    });
  });

  it('maps HTTP errors to PROVIDER_ERROR and retries 5xx', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response(JSON.stringify({ error: { message: 'backend error' } }), { status: 503 });
    }) as unknown as typeof fetch;
    await expect(gen(f).start({ prompt: 'x', aspect: '16:9' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('backend error'),
      details: { provider: 'google', status: 503 },
    });
    expect(n).toBe(3);
  });

  it('does not retry 400', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response(JSON.stringify({ error: { message: 'invalid argument' } }), { status: 400 });
    }) as unknown as typeof fetch;
    await expect(gen(f).start({ prompt: 'x', aspect: '16:9' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(n).toBe(1);
  });
});
