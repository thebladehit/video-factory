import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, type ProviderId } from '@vf/shared';

const RETRIES = 3;

/** fetch з ретраєм 429/5xx і мережевих збоїв (backoff) та мапінгом помилок у PROVIDER_ERROR. */
export async function requestWithRetry(
  provider: ProviderId,
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; retryDelayMs?: number } = {},
): Promise<Response> {
  const delay = opts.retryDelayMs ?? 1000;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted || attempt >= RETRIES) {
        throw new AppError('PROVIDER_ERROR', `${provider}: ${(e as Error).message}`, { provider });
      }
      await sleep(delay * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= RETRIES) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
      const message = (typeof body?.error === 'string' ? body.error : body?.error?.message) ?? res.statusText;
      throw new AppError('PROVIDER_ERROR', `${provider}: ${message}`, { provider, status: res.status });
    }
    await sleep(delay * 2 ** (attempt - 1), undefined, { signal: opts.signal });
  }
}

export function assertTtsLength(text: string, max: number): void {
  if (text.length > max) {
    throw new AppError(
      'VALIDATION',
      `Текст озвучки задовгий (${text.length} символів, максимум ${max}) — розділіть сегмент`,
      {
        length: text.length,
        max,
      },
    );
  }
}
