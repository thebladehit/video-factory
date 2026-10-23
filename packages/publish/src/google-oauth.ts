import { PublishError, type FetchFn, type OAuthProvider, type OAuthTokens } from './types';
import { apiError, NO_CHANNEL_MESSAGE, send } from './youtube';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

const toTokens = (t: TokenResponse): OAuthTokens => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  expiresAt: new Date(Date.now() + t.expires_in * 1000),
  scopes: t.scope ? t.scope.split(' ').filter(Boolean) : YOUTUBE_SCOPES,
});

export function createGoogleOAuth(opts: { clientId: string; clientSecret: string; fetch: FetchFn }): OAuthProvider {
  const { clientId, clientSecret, fetch } = opts;

  async function token(params: Record<string, string>): Promise<TokenResponse> {
    const res = await send(fetch, TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }).toString(),
    });
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as TokenResponse;
  }

  return {
    authUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: YOUTUBE_SCOPES.join(' '),
        // offline + consent — щоб Google щоразу видавав refresh token
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      return `${AUTH_URL}?${q}`;
    },

    async exchange(code, redirectUri) {
      const tokens = toTokens(await token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' }));
      const res = await send(fetch, CHANNELS_URL, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
      if (!res.ok) throw await apiError(res);
      const body = (await res.json()) as { items?: { id: string; snippet?: { title?: string; customUrl?: string } }[] };
      const ch = body.items?.[0];
      if (!ch) throw new PublishError('auth', NO_CHANNEL_MESSAGE, 'noChannel');
      const handle = ch.snippet?.customUrl;
      return {
        ...tokens,
        account: {
          externalId: ch.id,
          name: ch.snippet?.title ?? ch.id,
          profileUrl: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${ch.id}`,
        },
      };
    },

    async refresh(refreshToken) {
      const tokens = toTokens(await token({ refresh_token: refreshToken, grant_type: 'refresh_token' }));
      // Google зазвичай не повертає новий refresh token — лишаємо старий
      return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
    },
  };
}
