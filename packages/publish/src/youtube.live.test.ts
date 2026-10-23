import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGoogleOAuth } from './google-oauth';
import { createYoutubePublisher } from './youtube';

// Живий тест: лише `pnpm test:live`, потрібні YOUTUBE_CLIENT_ID/SECRET і refresh token тестового каналу
const env = process.env;
const FIXTURE = resolve(import.meta.dirname, '../../../apps/web/e2e/fixtures/tone.mp4');

describe.skipIf(!env.YOUTUBE_LIVE_REFRESH_TOKEN)('YouTube live', () => {
  it('uploads tone.mp4 as private and waits for processing', { timeout: 6 * 60_000 }, async () => {
    const oauth = createGoogleOAuth({
      clientId: env.YOUTUBE_CLIENT_ID ?? '',
      clientSecret: env.YOUTUBE_CLIENT_SECRET ?? '',
      fetch,
    });
    const { accessToken } = await oauth.refresh(env.YOUTUBE_LIVE_REFRESH_TOKEN!);
    const tokens = async () => accessToken;
    const publisher = createYoutubePublisher({ fetch });

    const size = statSync(FIXTURE).size;
    const res = await publisher.upload({
      tokens,
      file: {
        size,
        contentType: 'video/mp4',
        open: async (fromByte) => createReadStream(FIXTURE, { start: fromByte }),
      },
      meta: { title: 'vf live test', description: 'Автотест — можна видалити', tags: ['test'], privacy: 'private' },
      language: 'uk',
      format: '9:16',
      onSession: async () => {},
      onProgress: async () => {},
      signal: AbortSignal.timeout(5 * 60_000),
    });
    expect(res.platformPostId).toBeTruthy();

    const deadline = Date.now() + 5 * 60_000;
    let state = await publisher.status(tokens, res.platformPostId);
    while (state.state === 'processing' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10_000));
      state = await publisher.status(tokens, res.platformPostId);
    }
    expect(state.state).not.toBe('processing');
  });
});
