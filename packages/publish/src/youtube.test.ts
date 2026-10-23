import { Readable } from 'node:stream';
import type { PublicationMeta } from '@vf/shared';
import { describe, expect, it } from 'vitest';
import { PublishError, type UploadFile, type UploadRequest } from './types';
import { createYoutubePublisher } from './youtube';

const MiB = 1024 * 1024;
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  json?: unknown;
  bytes?: Uint8Array;
}

/** Байт файлу на позиції i — щоб перевірити, що сервер отримує саме ті байти */
const byteAt = (i: number) => i % 251;

function fakeFile(size: number): UploadFile & { opens: number[] } {
  const opens: number[] = [];
  return {
    size,
    contentType: 'video/mp4',
    opens,
    async open(from) {
      if (from >= size) throw new Error(`416: open(${from}) за межами файлу ${size}`);
      opens.push(from);
      // Віддаємо шматками по 1 МіБ (не кратно розміру чанка), щоб перевірити збирання буфера
      return Readable.from(
        (function* () {
          for (let pos = from; pos < size; pos += MiB) {
            const end = Math.min(pos + MiB, size);
            const buf = Buffer.alloc(end - pos);
            for (let i = 0; i < buf.length; i++) buf[i] = byteAt(pos + i);
            yield buf;
          }
        })(),
      );
    },
  };
}

type Override = (c: Call) => Response | undefined;

/** Підставний YouTube: resumable-сесії з лічильником прийнятих байтів */
function fakeYoutube(opts: { override?: Override; sessions?: Record<string, number>; videoId?: string } = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  const sessions = new Map<string, number>(Object.entries(opts.sessions ?? {}));
  let seq = 0;
  const videoId = opts.videoId ?? 'vid12345678';

  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const body = init?.body;
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers) };
    if (typeof body === 'string') call.json = JSON.parse(body);
    else if (body instanceof Uint8Array) call.bytes = body;
    calls.push(call);
    events.push(`${call.method} ${call.headers.get('content-range') ?? call.url}`);

    const o = opts.override?.(call);
    if (o) return o;

    if (call.method === 'POST' && call.url === UPLOAD_URL) {
      const uri = `https://upload.example/s/${++seq}`;
      sessions.set(uri, 0);
      return new Response(null, { status: 200, headers: { location: uri } });
    }
    if (call.method === 'PUT') {
      const received = sessions.get(call.url);
      if (received === undefined) return new Response('Not found', { status: 404 });
      const cr = call.headers.get('content-range')!;
      const size = Number(cr.split('/')[1]);
      const m = /^bytes (\d+)-(\d+)\//.exec(cr);
      if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        expect(a).toBe(received);
        expect(call.bytes!.length).toBe(b - a + 1);
        expect(call.headers.get('content-length')).toBe(String(b - a + 1));
        expect(call.bytes![0]).toBe(byteAt(a));
        expect(call.bytes![call.bytes!.length - 1]).toBe(byteAt(b));
        sessions.set(call.url, b + 1);
      }
      const now = sessions.get(call.url)!;
      if (now === size) return Response.json({ id: videoId, status: { uploadStatus: 'uploaded' } });
      return new Response(null, { status: 308, headers: now > 0 ? { range: `bytes=0-${now - 1}` } : {} });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof globalThis.fetch;

  return { fetch, calls, events, sessions };
}

const meta: PublicationMeta = { title: 'Назва', description: 'Опис', tags: ['#кава', 'ранок'] };

function req(
  file: UploadFile,
  over: Partial<UploadRequest> = {},
): UploadRequest & { progress: number[]; sessionsSaved: string[] } {
  const progress: number[] = [];
  const sessionsSaved: string[] = [];
  return {
    tokens: async () => 'tok',
    file,
    meta,
    language: 'uk',
    format: '9:16',
    onSession: async (uri) => {
      sessionsSaved.push(uri);
    },
    onProgress: async (pct) => {
      progress.push(pct);
    },
    signal: new AbortController().signal,
    progress,
    sessionsSaved,
    ...over,
  };
}

const ytError = (status: number, reason: string) =>
  Response.json(
    { error: { code: status, message: reason, errors: [{ reason, domain: 'youtube.quota' }] } },
    { status },
  );

describe('createYoutubePublisher.upload', () => {
  it('new upload: POST …/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status with X-Upload-Content-Length and body', async () => {
    const yt = fakeYoutube();
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    await pub.upload(req(fakeFile(1000)));
    const post = yt.calls[0]!;
    expect(post.method).toBe('POST');
    expect(post.url).toBe(UPLOAD_URL);
    expect(post.headers.get('x-upload-content-length')).toBe('1000');
    expect(post.headers.get('x-upload-content-type')).toBe('video/mp4');
    expect(post.headers.get('authorization')).toBe('Bearer tok');
    expect(post.headers.get('content-type')).toBe('application/json; charset=UTF-8');
    expect(post.json).toEqual({
      snippet: {
        title: 'Назва',
        description: 'Опис',
        tags: ['кава', 'ранок'],
        categoryId: '22',
        defaultLanguage: 'uk',
        defaultAudioLanguage: 'uk',
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    });
  });

  it('uses meta privacy, madeForKids and categoryId when set', async () => {
    const yt = fakeYoutube();
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    await pub.upload(
      req(fakeFile(1000), {
        meta: { ...meta, privacy: 'unlisted', madeForKids: true, categoryId: '10' },
        language: 'en',
      }),
    );
    expect(yt.calls[0]!.json).toMatchObject({
      snippet: { categoryId: '10', defaultLanguage: 'en', defaultAudioLanguage: 'en' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: true },
    });
  });

  it("publishAt → privacyStatus 'private' + publishAt ISO", async () => {
    const yt = fakeYoutube();
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const at = new Date('2026-11-01T10:00:00.000Z');
    await pub.upload(req(fakeFile(1000), { meta: { ...meta, privacy: 'unlisted' }, publishAt: at }));
    expect((yt.calls[0]!.json as { status: unknown }).status).toEqual({
      privacyStatus: 'private',
      publishAt: '2026-11-01T10:00:00.000Z',
      selfDeclaredMadeForKids: false,
    });
  });

  it('onSession called before first PUT', async () => {
    const yt = fakeYoutube();
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const r = req(fakeFile(1000));
    const onSession = r.onSession;
    r.onSession = async (uri) => {
      yt.events.push(`session ${uri}`);
      await onSession(uri);
    };
    await pub.upload(r);
    expect(yt.events).toEqual([`POST ${UPLOAD_URL}`, 'session https://upload.example/s/1', 'PUT bytes 0-999/1000']);
    expect(r.sessionsSaved).toEqual(['https://upload.example/s/1']);
  });

  it('20 MiB file → 3 PUTs with Content-Range bytes 0-8388607/20971520, …, 16777216-20971519/20971520', async () => {
    const yt = fakeYoutube();
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const file = fakeFile(20 * MiB);
    const r = req(file);
    const res = await pub.upload(r);
    const puts = yt.calls.filter((c) => c.method === 'PUT').map((c) => c.headers.get('content-range'));
    expect(puts).toEqual([
      'bytes 0-8388607/20971520',
      'bytes 8388608-16777215/20971520',
      'bytes 16777216-20971519/20971520',
    ]);
    expect(file.opens).toEqual([0]);
    expect(r.progress).toEqual([40, 80, 100]);
    expect(res.platformPostId).toBe('vid12345678');
  });

  it('resume: PUT bytes */size → 308 Range bytes=0-8388607 → continues from 8388608 (file.open(8388608))', async () => {
    const uri = 'https://upload.example/s/existing';
    const yt = fakeYoutube({ sessions: { [uri]: 8 * MiB } });
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const file = fakeFile(20 * MiB);
    const r = req(file, { resume: uri });
    await pub.upload(r);
    const first = yt.calls[0]!;
    expect(first.method).toBe('PUT');
    expect(first.url).toBe(uri);
    expect(first.headers.get('content-range')).toBe('bytes */20971520');
    expect(first.headers.get('content-length')).toBe('0');
    expect(yt.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(r.sessionsSaved).toEqual([]);
    expect(file.opens).toEqual([8 * MiB]);
    expect(yt.calls.slice(1).map((c) => c.headers.get('content-range'))).toEqual([
      'bytes 8388608-16777215/20971520',
      'bytes 16777216-20971519/20971520',
    ]);
  });

  it('resume when server already has all bytes → finishes without opening the file', async () => {
    const uri = 'https://upload.example/s/done';
    const yt = fakeYoutube({ sessions: { [uri]: 1000 } });
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const file = fakeFile(1000);
    const r = req(file, { resume: uri });
    const res = await pub.upload(r);
    expect(file.opens).toEqual([]);
    expect(yt.calls).toHaveLength(1);
    expect(res.platformPostId).toBe('vid12345678');
    expect(r.progress).toEqual([100]);
  });

  it('resume 404 → new session', async () => {
    const yt = fakeYoutube();
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const file = fakeFile(1000);
    const r = req(file, { resume: 'https://upload.example/s/expired' });
    await pub.upload(r);
    expect(yt.events).toEqual(['PUT bytes */1000', `POST ${UPLOAD_URL}`, 'PUT bytes 0-999/1000']);
    expect(r.sessionsSaved).toEqual(['https://upload.example/s/1']);
    expect(file.opens).toEqual([0]);
  });

  it('server accepted only part of a chunk → reopens file at the next byte', async () => {
    let cut = true;
    const yt = fakeYoutube({
      override: (c) => {
        if (cut && c.headers.get('content-range') === 'bytes 0-8388607/10485760') {
          cut = false;
          yt.sessions.set(c.url, 4 * MiB);
          return new Response(null, { status: 308, headers: { range: `bytes=0-${4 * MiB - 1}` } });
        }
        return undefined;
      },
    });
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const file = fakeFile(10 * MiB);
    await pub.upload(req(file));
    expect(file.opens).toEqual([0, 4 * MiB]);
    expect(yt.calls.filter((c) => c.method === 'PUT').map((c) => c.headers.get('content-range'))).toEqual([
      'bytes 0-8388607/10485760',
      'bytes 4194304-10485759/10485760',
    ]);
  });

  it('503 twice then 200 → success (re-queries session before continuing)', async () => {
    let fails = 2;
    const yt = fakeYoutube({
      override: (c) => {
        if (c.method === 'PUT' && /bytes \d/.test(c.headers.get('content-range') ?? '') && fails > 0) {
          fails--;
          return new Response('backend error', { status: 503 });
        }
        return undefined;
      },
    });
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const res = await pub.upload(req(fakeFile(1000)));
    expect(res.platformPostId).toBe('vid12345678');
    expect(yt.events).toEqual([
      `POST ${UPLOAD_URL}`,
      'PUT bytes 0-999/1000',
      'PUT bytes */1000',
      'PUT bytes 0-999/1000',
      'PUT bytes */1000',
      'PUT bytes 0-999/1000',
    ]);
  });

  it('network error is transient and retried', async () => {
    let fails = 1;
    const yt = fakeYoutube({
      override: (c) => {
        if (c.method === 'POST' && fails-- > 0) throw new TypeError('fetch failed');
        return undefined;
      },
    });
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    await pub.upload(req(fakeFile(1000)));
    expect(yt.events.filter((e) => e.startsWith('POST'))).toHaveLength(2);
  });

  it("503 on every attempt → PublishError 'transient' after 5 retries", async () => {
    const yt = fakeYoutube({ override: (c) => (c.method === 'POST' ? new Response('x', { status: 503 }) : undefined) });
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const err = await pub.upload(req(fakeFile(1000))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).reason).toBe('transient');
    expect(yt.calls).toHaveLength(6);
  });

  it("403 quotaExceeded → PublishError 'quota', no retry", async () => {
    const yt = fakeYoutube({ override: () => ytError(403, 'quotaExceeded') });
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const err = await pub.upload(req(fakeFile(1000))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).reason).toBe('quota');
    expect((err as PublishError).platformReason).toBe('quotaExceeded');
    expect((err as PublishError).message).toBe(
      'Вичерпано добову квоту YouTube API (скидається опівночі за тихоокеанським часом)',
    );
    expect(yt.calls).toHaveLength(1);
  });

  it("401 → PublishError 'auth', no retry", async () => {
    const yt = fakeYoutube({ override: () => ytError(401, 'authError') });
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const err = await pub.upload(req(fakeFile(1000))).catch((e: unknown) => e);
    expect((err as PublishError).reason).toBe('auth');
    expect(yt.calls).toHaveLength(1);
  });

  it('result url shorts/<id> for 9:16, watch?v=<id> for 16:9', async () => {
    const pub = createYoutubePublisher({ fetch: fakeYoutube().fetch, retryDelayMs: 0 });
    expect(await pub.upload(req(fakeFile(10), { format: '9:16' }))).toEqual({
      platformPostId: 'vid12345678',
      url: 'https://www.youtube.com/shorts/vid12345678',
    });
    const pub2 = createYoutubePublisher({ fetch: fakeYoutube().fetch, retryDelayMs: 0 });
    expect(await pub2.upload(req(fakeFile(10), { format: '16:9' }))).toEqual({
      platformPostId: 'vid12345678',
      url: 'https://www.youtube.com/watch?v=vid12345678',
    });
  });

  it('aborted signal stops between chunks with AbortError, not PublishError', async () => {
    const yt = fakeYoutube();
    const pub = createYoutubePublisher({ fetch: yt.fetch, retryDelayMs: 0 });
    const ac = new AbortController();
    const r = req(fakeFile(20 * MiB), { signal: ac.signal });
    r.onProgress = async () => ac.abort();
    const err = await pub.upload(r).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PublishError);
    expect((err as Error).name).toBe('AbortError');
    expect(yt.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});

describe('createYoutubePublisher.status', () => {
  const statusFetch = (item: unknown) => {
    const urls: string[] = [];
    const fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      urls.push(String(input));
      return Response.json({ items: item ? [item] : [] });
    }) as typeof globalThis.fetch;
    return { fetch, urls };
  };

  it('processed → ready', async () => {
    const f = statusFetch({ id: 'v1', status: { uploadStatus: 'processed' } });
    const pub = createYoutubePublisher({ fetch: f.fetch });
    expect(await pub.status(async () => 'tok', 'v1')).toEqual({ state: 'ready' });
    expect(f.urls[0]).toBe('https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=v1');
  });

  it("rejected (rejectionReason 'duplicate') → failed with reason", async () => {
    const f = statusFetch({ id: 'v1', status: { uploadStatus: 'rejected', rejectionReason: 'duplicate' } });
    const pub = createYoutubePublisher({ fetch: f.fetch });
    const res = await pub.status(async () => 'tok', 'v1');
    expect(res.state).toBe('failed');
    expect(res.error).toContain('duplicate');
  });

  it("failed (failureReason 'codec') → failed with reason", async () => {
    const f = statusFetch({ id: 'v1', status: { uploadStatus: 'failed', failureReason: 'codec' } });
    const pub = createYoutubePublisher({ fetch: f.fetch });
    const res = await pub.status(async () => 'tok', 'v1');
    expect(res.state).toBe('failed');
    expect(res.error).toContain('codec');
  });

  it('uploaded → processing', async () => {
    const f = statusFetch({ id: 'v1', status: { uploadStatus: 'uploaded' } });
    const pub = createYoutubePublisher({ fetch: f.fetch });
    expect(await pub.status(async () => 'tok', 'v1')).toEqual({ state: 'processing' });
  });
});
