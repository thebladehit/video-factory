import { randomUUID } from 'node:crypto';
import type { Platform } from '@vf/shared';
import { YOUTUBE_SCOPES } from './google-oauth';
import type { OAuthProvider, OAuthTokens, Publisher } from './types';
import { youtubeVideoUrl } from './youtube';

const fakeTokens = (refreshToken = 'fake-refresh'): OAuthTokens => ({
  accessToken: 'fake-access',
  refreshToken,
  expiresAt: new Date(Date.now() + 3600_000),
  scopes: YOUTUBE_SCOPES,
});

/** OAuth без Google — для e2e та інтеграційних тестів: «згода» одразу повертає на redirectUri */
export function createFakeOAuth(): OAuthProvider {
  return {
    authUrl: (state, redirectUri) => `${redirectUri}?code=fake&state=${state}`,
    exchange: async () => ({
      ...fakeTokens(),
      account: { externalId: 'fake-channel', name: 'Тестовий канал', profileUrl: 'https://www.youtube.com/@fake' },
    }),
    refresh: async (refreshToken) => fakeTokens(refreshToken),
  };
}

const fakePostUrl: Record<Platform, (id: string, format: '9:16' | '16:9') => string> = {
  youtube: youtubeVideoUrl,
  tiktok: (id) => `https://www.tiktok.com/@fake/video/${id}`,
  instagram: (id) => `https://www.instagram.com/reel/${id}/`,
  facebook: (id) => `https://www.facebook.com/reel/${id}`,
};

/** Миттєве «завантаження»: читає файл до кінця, id `fake-<uuid>`, статус одразу ready */
export function createFakePublisher(platform: Platform): Publisher {
  return {
    platform,
    async upload(req) {
      req.signal.throwIfAborted();
      await req.onSession('fake-session');
      // open(size) у S3 дає 416 — порожній файл не відкриваємо
      if (req.file.size > 0) {
        for await (const chunk of await req.file.open(0)) {
          void chunk;
          req.signal.throwIfAborted();
        }
      }
      await req.onProgress(100);
      const id = `fake-${randomUUID()}`;
      return { platformPostId: id, url: fakePostUrl[platform](id, req.format) };
    },
    status: async () => ({ state: 'ready' }),
  };
}
