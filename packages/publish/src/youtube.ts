import type { Readable } from 'node:stream';
import { normalizeTag } from './limits';
import {
  PublishError,
  type AccessTokenSource,
  type FetchFn,
  type Publisher,
  type PublishStatus,
  type UploadRequest,
  type VideoFormat,
} from './types';

/** 8 МіБ — кратно 256 КіБ, як вимагає resumable upload */
export const YOUTUBE_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_RETRIES = 5;
const DEFAULT_CATEGORY = '22';

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

export const QUOTA_MESSAGE = 'Вичерпано добову квоту YouTube API (скидається опівночі за тихоокеанським часом)';
export const NO_CHANNEL_MESSAGE = 'На цьому Google-акаунті немає YouTube-каналу';
export const AUTH_LOST_MESSAGE = 'Підключення до каналу втрачено — перепідключіть';

export const youtubeVideoUrl = (id: string, format: VideoFormat) =>
  format === '9:16' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;

/** Запит через переданий fetch: мережева помилка → transient, переривання signal пробрасується як є */
export async function send(fetch: FetchFn, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal });
  } catch (e) {
    if (signal?.aborted || (e as Error | undefined)?.name === 'AbortError') throw e;
    throw new PublishError('transient', 'Не вдалося з’єднатися з Google', (e as Error | undefined)?.message);
  }
}

/** Помилка API Google → PublishError: error.errors[0].reason (YouTube) або error (OAuth) → platformReason */
export async function apiError(res: Response): Promise<PublishError> {
  let reason: string | undefined;
  try {
    const body = (await res.json()) as { error?: string | { errors?: { reason?: string }[] } };
    reason = typeof body.error === 'string' ? body.error : body.error?.errors?.[0]?.reason;
  } catch {
    // тіло не JSON — лишається лише HTTP-статус
  }
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded')
    return new PublishError('quota', QUOTA_MESSAGE, reason);
  if (reason === 'youtubeSignupRequired') return new PublishError('auth', NO_CHANNEL_MESSAGE, reason);
  // хибні облікові дані OAuth-клієнта на сервері: перепідключення каналу не допоможе
  if (reason === 'invalid_client' || reason === 'unauthorized_client')
    return new PublishError(
      'other',
      `Google відхилив OAuth-клієнт сервера (${reason}) — перевірте налаштування`,
      reason,
    );
  if (res.status === 401 || reason === 'invalid_grant') return new PublishError('auth', AUTH_LOST_MESSAGE, reason);
  if (res.status >= 500)
    return new PublishError('transient', `YouTube тимчасово недоступний (HTTP ${res.status})`, reason);
  if (reason === 'forbidden') return new PublishError('other', 'YouTube відмовив у доступі (forbidden)', reason);
  return new PublishError('other', `Помилка YouTube API (HTTP ${res.status}${reason ? `, ${reason}` : ''})`, reason);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Читає з потоку рівно n байтів за раз (потік S3 віддає шматки довільного розміру) */
class ChunkReader {
  private readonly it: AsyncIterator<unknown>;
  private rest: Buffer = Buffer.alloc(0);

  constructor(private readonly stream: Readable) {
    this.it = stream[Symbol.asyncIterator]();
  }

  async read(n: number): Promise<Buffer> {
    const parts = [this.rest];
    let len = this.rest.length;
    while (len < n) {
      let r: IteratorResult<unknown>;
      try {
        r = await this.it.next();
      } catch (e) {
        // обрив потоку зі сховища — тимчасова помилка, продовжимо з сесії
        throw new PublishError('transient', 'Помилка читання файлу відео', (e as Error | undefined)?.message);
      }
      if (r.done) throw new PublishError('other', 'Файл відео коротший, ніж очікувалось');
      const b = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value as Uint8Array);
      parts.push(b);
      len += b.length;
    }
    const all = Buffer.concat(parts, len);
    this.rest = all.subarray(n);
    return all.subarray(0, n);
  }

  close() {
    this.stream.destroy();
  }
}

/** Скільки байтів сервер уже має: заголовок Range «bytes=0-N» → N + 1 */
function receivedBytes(res: Response): number {
  const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

async function videoId(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) throw new PublishError('other', 'YouTube не повернув id відео');
  return body.id;
}

type SessionState = { kind: 'done'; id: string } | { kind: 'expired' } | { kind: 'partial'; received: number };

export function createYoutubePublisher(opts: { fetch: FetchFn; chunkSize?: number; retryDelayMs?: number }): Publisher {
  const { fetch } = opts;
  const chunkSize = opts.chunkSize ?? YOUTUBE_CHUNK_SIZE;
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  async function createSession(req: UploadRequest): Promise<string> {
    const { meta, publishAt } = req;
    const body = {
      snippet: {
        title: meta.title,
        description: meta.description,
        tags: meta.tags.map(normalizeTag).filter(Boolean),
        categoryId: meta.categoryId ?? DEFAULT_CATEGORY,
        defaultLanguage: req.language,
        defaultAudioLanguage: req.language,
      },
      // Запланована публікація: лише private + publishAt — YouTube сам відкриє відео в цей час
      status: publishAt
        ? {
            privacyStatus: 'private',
            publishAt: publishAt.toISOString(),
            selfDeclaredMadeForKids: meta.madeForKids ?? false,
          }
        : { privacyStatus: meta.privacy ?? 'public', selfDeclaredMadeForKids: meta.madeForKids ?? false },
    };
    const res = await send(
      fetch,
      UPLOAD_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await req.tokens()}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(req.file.size),
          'X-Upload-Content-Type': req.file.contentType,
        },
        body: JSON.stringify(body),
      },
      req.signal,
    );
    if (!res.ok) throw await apiError(res);
    const uri = res.headers.get('location');
    if (!uri) throw new PublishError('other', 'YouTube не повернув адресу сесії завантаження');
    return uri;
  }

  /** PUT «bytes *\/size» — дізнатися, скільки байтів сесія вже прийняла */
  async function querySession(uri: string, req: UploadRequest): Promise<SessionState> {
    const res = await send(
      fetch,
      uri,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await req.tokens()}`,
          'Content-Length': '0',
          'Content-Range': `bytes */${req.file.size}`,
        },
      },
      req.signal,
    );
    if (res.ok) return { kind: 'done', id: await videoId(res) };
    if (res.status === 404 || res.status === 410) return { kind: 'expired' };
    if (res.status === 308) return { kind: 'partial', received: receivedBytes(res) };
    throw await apiError(res);
  }

  /** Передає байти від offset шматками; повертає id відео після останнього шматка */
  async function sendFrom(uri: string, offset: number, req: UploadRequest): Promise<string> {
    const { file, signal } = req;
    let reader: ChunkReader | undefined;
    let pos = offset;
    try {
      for (;;) {
        signal.throwIfAborted();
        // S3 повертає 416 на fromByte ≥ size, тож сюди потрапляємо лише з pos < size
        reader ??= new ChunkReader(await file.open(pos));
        const len = Math.min(chunkSize, file.size - pos);
        const chunk = await reader.read(len);
        const res = await send(
          fetch,
          uri,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${await req.tokens()}`,
              'Content-Length': String(len),
              'Content-Range': `bytes ${pos}-${pos + len - 1}/${file.size}`,
            },
            body: chunk as Uint8Array<ArrayBuffer>,
          },
          signal,
        );
        if (res.ok) return await videoId(res);
        if (res.status === 404 || res.status === 410) {
          // сесія прострочилась посеред передачі — повтор перевірить її й відкриє нову
          throw new PublishError('transient', 'Сесія завантаження YouTube прострочена');
        }
        if (res.status !== 308) throw await apiError(res);
        const next = receivedBytes(res);
        if (next >= file.size)
          throw new PublishError('transient', 'YouTube отримав файл, але не завершив завантаження');
        if (next !== pos + len) {
          // сервер прийняв не весь шматок — читаємо файл заново з потрібного байта
          reader.close();
          reader = undefined;
        }
        pos = next;
        await req.onProgress(Math.floor((pos / file.size) * 100));
      }
    } finally {
      reader?.close();
    }
  }

  return {
    platform: 'youtube',

    async upload(req) {
      const { signal } = req;
      let session = req.resume;
      // null — невідомо, скільки байтів уже на сервері: треба спитати сесію
      let offset: number | null = session ? null : 0;
      for (let attempt = 0; ; attempt++) {
        try {
          signal.throwIfAborted();
          if (session && offset === null) {
            const state = await querySession(session, req);
            if (state.kind === 'done') {
              await req.onProgress(100);
              return { platformPostId: state.id, url: youtubeVideoUrl(state.id, req.format) };
            }
            if (state.kind === 'expired') session = undefined;
            else if (state.received >= req.file.size) {
              throw new PublishError('transient', 'YouTube отримав файл, але не завершив завантаження');
            } else offset = state.received;
          }
          if (!session) {
            session = await createSession(req);
            offset = 0;
            await req.onSession(session);
          }
          const id = await sendFrom(session, offset ?? 0, req);
          await req.onProgress(100);
          return { platformPostId: id, url: youtubeVideoUrl(id, req.format) };
        } catch (e) {
          if (!(e instanceof PublishError) || e.reason !== 'transient' || attempt >= MAX_RETRIES) throw e;
          offset = null;
          await sleep(retryDelayMs * 2 ** attempt, signal);
        }
      }
    },

    async status(tokens: AccessTokenSource, platformPostId: string): Promise<PublishStatus> {
      const res = await send(
        fetch,
        `${VIDEOS_URL}?part=status,processingDetails&id=${encodeURIComponent(platformPostId)}`,
        {
          headers: { Authorization: `Bearer ${await tokens()}` },
        },
      );
      if (!res.ok) throw await apiError(res);
      const body = (await res.json()) as {
        items?: { status?: { uploadStatus?: string; rejectionReason?: string; failureReason?: string } }[];
      };
      const st = body.items?.[0]?.status;
      // Щойно завантажене відео може ще не з'явитися у списку — чекаємо (тайм-аут обробки — у сервісі)
      switch (st?.uploadStatus) {
        case 'processed':
          return { state: 'ready' };
        case 'rejected':
          return { state: 'failed', error: `YouTube відхилив відео: ${st.rejectionReason ?? 'невідома причина'}` };
        case 'failed':
          return {
            state: 'failed',
            error: `YouTube не зміг обробити відео: ${st.failureReason ?? 'невідома причина'}`,
          };
        case 'deleted':
          return { state: 'failed', error: 'Відео видалено з YouTube' };
        default:
          return { state: 'processing' };
      }
    },
  };
}
