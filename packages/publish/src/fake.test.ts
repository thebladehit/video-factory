import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFakeOAuth, createFakePublisher } from './fake';

describe('fakes', () => {
  it('createFakeOAuth: authUrl redirects back with code=fake; exchange returns the fake channel', async () => {
    const oauth = createFakeOAuth();
    expect(oauth.authUrl('st', 'http://localhost/cb')).toBe('http://localhost/cb?code=fake&state=st');
    const res = await oauth.exchange('fake', 'http://localhost/cb');
    expect(res.account).toEqual({
      externalId: 'fake-channel',
      name: 'Тестовий канал',
      profileUrl: 'https://www.youtube.com/@fake',
    });
    expect((await oauth.refresh('rt')).refreshToken).toBe('rt');
  });

  it('createFakePublisher reads the whole file, reports session/progress and is ready', async () => {
    const pub = createFakePublisher('youtube');
    let consumed = 0;
    const sessions: string[] = [];
    const progress: number[] = [];
    const res = await pub.upload({
      tokens: async () => 't',
      file: {
        size: 6,
        contentType: 'video/mp4',
        open: async () => {
          const s = Readable.from([Buffer.from('abc'), Buffer.from('def')]);
          s.on('data', (b: Buffer) => (consumed += b.length));
          return s;
        },
      },
      meta: { title: 'x', description: '', tags: [] },
      language: 'uk',
      format: '9:16',
      onSession: async (u) => void sessions.push(u),
      onProgress: async (p) => void progress.push(p),
      signal: new AbortController().signal,
    });
    expect(consumed).toBe(6);
    expect(sessions).toEqual(['fake-session']);
    expect(progress).toEqual([100]);
    expect(res.platformPostId).toMatch(/^fake-[0-9a-f-]{36}$/);
    expect(res.url).toBe(`https://www.youtube.com/shorts/${res.platformPostId}`);
    expect(await pub.status(async () => 't', res.platformPostId)).toEqual({ state: 'ready' });
  });
});
