import { describe, expect, it } from 'vitest';
import { createGoogleOAuth } from './google-oauth';
import { PublishError } from './types';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function recordingFetch(handler: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : '',
    };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const channel = { items: [{ id: 'UC123', snippet: { title: 'Мій канал', customUrl: '@mychannel' } }] };

describe('createGoogleOAuth', () => {
  it('authUrl contains client_id, both scopes, access_type=offline, prompt=consent, state, redirect_uri', () => {
    const { fetch } = recordingFetch(() => json({}));
    const oauth = createGoogleOAuth({ clientId: 'cid', clientSecret: 'sec', fetch });
    const u = new URL(oauth.authUrl('st-1', 'http://localhost:5173/oauth/youtube/callback'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    );
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('st-1');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:5173/oauth/youtube/callback');
  });

  it('exchange posts code → tokens; then GET channels?part=snippet&mine=true → account (id, title, https://www.youtube.com/<customUrl>)', async () => {
    const { fetch, calls } = recordingFetch((c) =>
      c.url.startsWith('https://oauth2.googleapis.com/token')
        ? json({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
          })
        : json(channel),
    );
    const oauth = createGoogleOAuth({ clientId: 'cid', clientSecret: 'sec', fetch });
    const before = Date.now();
    const res = await oauth.exchange('code-1', 'http://localhost/cb');

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0]!.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      code: 'code-1',
      client_id: 'cid',
      client_secret: 'sec',
      redirect_uri: 'http://localhost/cb',
      grant_type: 'authorization_code',
    });

    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.url).toBe('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true');
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer at-1');

    expect(res.accessToken).toBe('at-1');
    expect(res.refreshToken).toBe('rt-1');
    expect(res.scopes).toEqual([
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ]);
    expect(res.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    expect(res.account).toEqual({
      externalId: 'UC123',
      name: 'Мій канал',
      profileUrl: 'https://www.youtube.com/@mychannel',
    });
  });

  it('refresh returns new access token and keeps old refresh token when none returned', async () => {
    const { fetch, calls } = recordingFetch(() => json({ access_token: 'at-2', expires_in: 3599 }));
    const oauth = createGoogleOAuth({ clientId: 'cid', clientSecret: 'sec', fetch });
    const res = await oauth.refresh('rt-old');
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rt-old');
    expect(res.accessToken).toBe('at-2');
    expect(res.refreshToken).toBe('rt-old');
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("refresh with {error:'invalid_grant'} → PublishError reason 'auth'", async () => {
    const { fetch } = recordingFetch(() =>
      json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
    );
    const oauth = createGoogleOAuth({ clientId: 'cid', clientSecret: 'sec', fetch });
    const err = await oauth.refresh('rt-old').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).reason).toBe('auth');
    expect((err as PublishError).platformReason).toBe('invalid_grant');
  });

  it.each(['invalid_client', 'unauthorized_client'])(
    "refresh with {error:'%s'} (401) → reason 'other'",
    async (code) => {
      const { fetch } = recordingFetch(() => json({ error: code }, 401));
      const oauth = createGoogleOAuth({ clientId: 'cid', clientSecret: 'sec', fetch });
      const err = await oauth.refresh('rt-old').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublishError);
      expect((err as PublishError).reason).toBe('other');
      expect((err as PublishError).platformReason).toBe(code);
      const ex = await oauth.exchange('code-1', 'http://localhost/cb').catch((e: unknown) => e);
      expect((ex as PublishError).reason).toBe('other');
    },
  );

  it("exchange when channels.items empty → PublishError 'auth' with 'На цьому Google-акаунті немає YouTube-каналу'", async () => {
    const { fetch } = recordingFetch((c) =>
      c.url.startsWith('https://oauth2.googleapis.com/token')
        ? json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
        : json({ items: [] }),
    );
    const oauth = createGoogleOAuth({ clientId: 'cid', clientSecret: 'sec', fetch });
    const err = await oauth.exchange('code-1', 'http://localhost/cb').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).reason).toBe('auth');
    expect((err as PublishError).message).toBe('На цьому Google-акаунті немає YouTube-каналу');
  });
});
