import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '@vf/shared';
import type { GeneratedFile, OpStatus, VideoGen } from '../types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RETRIES = 3;

interface Interaction {
  id: string;
  status: 'queued' | 'in_progress' | 'requires_action' | 'completed' | 'failed' | 'cancelled' | 'incomplete';
  steps?: unknown[];
  errors?: { code?: string; message?: string }[];
}
interface VideoPart {
  type: 'video';
  mime_type?: string;
  data?: string;
  uri?: string;
}

/** Відео-частини відповіді (у `steps[].content[]`; шукаємо рекурсивно — форма кроків може розширюватись). */
function findVideos(node: unknown, out: VideoPart[] = []): VideoPart[] {
  if (Array.isArray(node)) for (const n of node) findVideos(n, out);
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.type === 'video' && (typeof o.data === 'string' || typeof o.uri === 'string'))
      out.push(o as unknown as VideoPart);
    else for (const v of Object.values(o)) findVideos(v, out);
  }
  return out;
}

/**
 * Gemini Omni Flash (відео) через Interactions API: створення у фоні (`background: true`)
 * і опитування `GET /interactions/{id}`. Veo 3.1 preview у Gemini API вимикається 2026-10-22.
 */
export function createGeminiOmniVideoGen(opts: {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}): VideoGen {
  const doFetch = opts.fetch ?? fetch;
  const headers = { 'x-goog-api-key': opts.apiKey, 'content-type': 'application/json' };

  async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, { ...init, headers, signal });
      } catch (e) {
        if (signal?.aborted || attempt >= RETRIES) {
          throw new AppError('PROVIDER_ERROR', `google: ${(e as Error).message}`, { provider: 'google' });
        }
        await sleep((opts.retryDelayMs ?? 1000) * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= RETRIES) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        const message = body?.error?.message ?? res.statusText;
        throw new AppError('PROVIDER_ERROR', `google: ${message}`, { provider: 'google', status: res.status });
      }
      await sleep((opts.retryDelayMs ?? 1000) * 2 ** (attempt - 1), undefined, { signal });
    }
  }

  async function download(part: VideoPart, signal?: AbortSignal): Promise<GeneratedFile> {
    const mime = part.mime_type ?? 'video/mp4';
    if (part.data) return { bytes: new Uint8Array(Buffer.from(part.data, 'base64')), mime };
    const res = await request(part.uri!, { method: 'GET' }, signal);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime };
  }

  return {
    async start({ prompt, aspect, signal }) {
      const res = await request(
        `${BASE}/interactions`,
        {
          method: 'POST',
          body: JSON.stringify({
            model: opts.model,
            input: prompt,
            background: true,
            response_format: { type: 'video', aspect_ratio: aspect, resolution: '720p' },
          }),
        },
        signal,
      );
      const it = (await res.json()) as Interaction;
      return { provider: 'google', data: { id: it.id } };
    },

    async poll(ref, { signal } = {}) {
      const { id } = ref.data as { id: string };
      const res = await request(`${BASE}/interactions/${encodeURIComponent(id)}`, { method: 'GET' }, signal);
      const it = (await res.json()) as Interaction;
      if (it.status === 'completed') {
        const videos = findVideos(it.steps ?? it);
        if (!videos.length) return { state: 'failed', error: 'Провайдер не повернув відео' } satisfies OpStatus;
        return Promise.all(videos.map((v) => download(v, signal)));
      }
      if (it.status === 'failed' || it.status === 'cancelled' || it.status === 'incomplete') {
        return { state: 'failed', error: it.errors?.[0]?.message ?? `Генерацію завершено зі статусом ${it.status}` };
      }
      return { state: 'running' };
    },
  };
}
