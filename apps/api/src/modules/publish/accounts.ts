import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm';
import { publications, socialAccounts } from '@vf/db';
import { AUTH_LOST_MESSAGE, PublishError, type AccessTokenSource, type OAuthProvider } from '@vf/publish';
import {
  AppError,
  languageInfo,
  LIVE_PUBLICATION_STATUSES,
  type AccountStatus,
  type Platform,
  type PublishMethod,
} from '@vf/shared';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { decryptJson, encryptJson, signState, verifyState } from './crypto';

/** Акаунт для клієнта — без токенів і scopes */
export interface AccountView {
  id: string;
  platform: Platform;
  method: PublishMethod;
  name: string;
  language: string;
  externalId: string | null;
  profileUrl: string | null;
  status: AccountStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Явний перелік колонок: токени ніколи не читаються в публічні відповіді */
const viewColumns = {
  id: socialAccounts.id,
  platform: socialAccounts.platform,
  method: socialAccounts.method,
  name: socialAccounts.name,
  language: socialAccounts.language,
  externalId: socialAccounts.externalId,
  profileUrl: socialAccounts.profileUrl,
  status: socialAccounts.status,
  createdAt: socialAccounts.createdAt,
  updatedAt: socialAccounts.updatedAt,
};

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
}

const NOT_CONFIGURED = 'Додайте YOUTUBE_CLIENT_ID і YOUTUBE_CLIENT_SECRET у .env';
const notFound = () => new AppError('NOT_FOUND', 'Акаунт не знайдено');
const LIVE = [...LIVE_PUBLICATION_STATUSES];

export const oauthRedirectUri = (deps: AppDeps, platform: Platform) =>
  `${deps.publish.redirectBase}/oauth/${platform}/callback`;

const parseName = (name: string) => {
  const n = name.trim();
  if (!n || n.length > 100) throw new AppError('VALIDATION', 'Назва акаунта: від 1 до 100 символів');
  return n;
};

const parseLanguage = (code: string) => languageInfo(code).code;

/** Порожньо → null; інакше лише http(s)-посилання */
const parseProfileUrl = (raw: string | undefined) => {
  const v = raw?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new AppError('VALIDATION', 'Некоректне посилання на профіль');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new AppError('VALIDATION', 'Некоректне посилання на профіль');
  }
  return u.toString();
};

/** `details.reason` для callback OAuth: сервер не налаштований — не «застаріле посилання» */
const notConfigured = (message: string) => new AppError('VALIDATION', message, { reason: 'notConfigured' });

function requireKey(deps: AppDeps): Buffer {
  if (!deps.publish.tokenKey) throw notConfigured('Не задано TOKEN_ENCRYPTION_KEY у .env');
  return deps.publish.tokenKey;
}

function requireProvider(deps: AppDeps, platform: Platform): OAuthProvider {
  const provider = deps.publish.oauth[platform];
  if (!provider) throw notConfigured(NOT_CONFIGURED);
  return provider;
}

async function view(deps: AppDeps, userId: string, id: string): Promise<AccountView> {
  const [row] = await deps.db
    .select(viewColumns)
    .from(socialAccounts)
    .where(and(eq(socialAccounts.id, id), eq(socialAccounts.userId, userId)));
  if (!row) throw notFound();
  return row;
}

export async function listAccounts(deps: AppDeps, userId: string) {
  const accounts: AccountView[] = await deps.db
    .select(viewColumns)
    .from(socialAccounts)
    .where(eq(socialAccounts.userId, userId))
    .orderBy(asc(socialAccounts.platform), asc(socialAccounts.createdAt));
  return {
    accounts,
    youtubeConfigured: Boolean(deps.publish.oauth.youtube),
    youtubeAudited: deps.publish.youtubeAudited,
  };
}

export async function createManualAccount(
  deps: AppDeps,
  userId: string,
  input: { platform: Platform; name: string; language: string; profileUrl?: string },
): Promise<AccountView> {
  const [row] = await deps.db
    .insert(socialAccounts)
    .values({
      userId,
      platform: input.platform,
      method: 'manual',
      name: parseName(input.name),
      language: parseLanguage(input.language),
      profileUrl: parseProfileUrl(input.profileUrl),
    })
    .returning({ id: socialAccounts.id });
  return view(deps, userId, row!.id);
}

export async function updateAccount(
  deps: AppDeps,
  userId: string,
  input: { id: string; name?: string; language?: string; profileUrl?: string },
): Promise<AccountView> {
  if (!isUuid(input.id)) throw notFound();
  const patch: Partial<typeof socialAccounts.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = parseName(input.name);
  if (input.language !== undefined) patch.language = parseLanguage(input.language);
  if (input.profileUrl !== undefined) patch.profileUrl = parseProfileUrl(input.profileUrl);
  const [row] = await deps.db
    .update(socialAccounts)
    .set(patch)
    .where(and(eq(socialAccounts.id, input.id), eq(socialAccounts.userId, userId)))
    .returning({ id: socialAccounts.id });
  if (!row) throw notFound();
  return view(deps, userId, row.id);
}

/** Публікації акаунта видаляються каскадом — тому живі блокують видалення */
export async function removeAccount(deps: AppDeps, userId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw notFound();
  await view(deps, userId, id);
  // перевірка й видалення одним запитом: нова жива публікація між ними не проскочить
  const rows = await deps.db
    .delete(socialAccounts)
    .where(
      and(
        eq(socialAccounts.id, id),
        eq(socialAccounts.userId, userId),
        notExists(
          deps.db
            .select({ one: sql`1` })
            .from(publications)
            .where(and(eq(publications.accountId, id), inArray(publications.status, LIVE))),
        ),
      ),
    )
    .returning({ id: socialAccounts.id });
  if (!rows.length) throw new AppError('CONFLICT', 'Акаунт має публікації в роботі');
}

export function connectUrl(
  deps: AppDeps,
  userId: string,
  input: { platform: 'youtube'; language: string },
): { url: string } {
  const provider = requireProvider(deps, input.platform);
  const state = signState(requireKey(deps), {
    userId,
    language: parseLanguage(input.language),
    platform: input.platform,
  });
  return { url: provider.authUrl(state, oauthRedirectUri(deps, input.platform)) };
}

/** null — токени не розшифровуються (змінено TOKEN_ENCRYPTION_KEY чи пошкоджено рядок) */
function tryDecrypt(key: Buffer, enc: string): StoredTokens | null {
  try {
    return decryptJson<StoredTokens>(key, enc);
  } catch {
    return null;
  }
}

/**
 * Callback OAuth: state → exchange → upsert за (user, platform, external_id).
 * Невалідний state → VALIDATION; збій обміну коду → PROVIDER_ERROR (`details.platformReason`).
 */
export async function completeOAuth(
  deps: AppDeps,
  input: { code: string; state: string; userId?: string },
): Promise<string> {
  const key = requireKey(deps);
  const state = verifyState(key, input.state);
  // state видано іншому користувачу — не приймаємо
  if (input.userId && input.userId !== state.userId) {
    throw new AppError('VALIDATION', 'Посилання підключення застаріло — спробуйте ще раз');
  }
  const provider = requireProvider(deps, state.platform);
  let result: Awaited<ReturnType<OAuthProvider['exchange']>>;
  try {
    result = await provider.exchange(input.code, oauthRedirectUri(deps, state.platform));
  } catch (e) {
    throw new AppError('PROVIDER_ERROR', e instanceof Error ? e.message : 'Не вдалося підключити канал', {
      reason: e instanceof PublishError ? e.reason : undefined,
      platformReason: e instanceof PublishError ? e.platformReason : undefined,
    });
  }
  const { account } = result;

  let refreshToken = result.refreshToken;
  if (!refreshToken) {
    // Google не завжди повертає refresh token повторно — лишаємо збережений
    const [existing] = await deps.db
      .select({ tokensEnc: socialAccounts.tokensEnc })
      .from(socialAccounts)
      .where(
        and(
          eq(socialAccounts.userId, state.userId),
          eq(socialAccounts.platform, state.platform),
          eq(socialAccounts.externalId, account.externalId),
        ),
      );
    // нерозшифровні збережені токени — як «немає refresh token»: перепідключення не блокуємо
    if (existing?.tokensEnc) refreshToken = tryDecrypt(key, existing.tokensEnc)?.refreshToken;
  }
  const tokensEnc = encryptJson(key, { accessToken: result.accessToken, refreshToken } satisfies StoredTokens);
  const fields = {
    method: 'api' as const,
    name: account.name,
    language: state.language,
    profileUrl: account.profileUrl,
    tokensEnc,
    scopes: result.scopes,
    tokenExpiresAt: result.expiresAt,
    status: 'active' as const,
  };
  const [row] = await deps.db
    .insert(socialAccounts)
    .values({ userId: state.userId, platform: state.platform, externalId: account.externalId, ...fields })
    .onConflictDoUpdate({
      target: [socialAccounts.userId, socialAccounts.platform, socialAccounts.externalId],
      targetWhere: sql`${socialAccounts.externalId} is not null`,
      set: { ...fields, updatedAt: new Date() },
    })
    .returning({ id: socialAccounts.id });
  return row!.id;
}

/**
 * Джерело access token для публікатора: перед кожним викликом читає свіжий стан акаунта,
 * за потреби оновлює токен і зберігає новий. `PublishError 'auth'` → `reauth_required`.
 */
export function accessTokenFor(deps: AppDeps, account: { id: string; platform: Platform }): AccessTokenSource {
  return async () => {
    const key = requireKey(deps);
    const [row] = await deps.db
      .select({ tokensEnc: socialAccounts.tokensEnc, tokenExpiresAt: socialAccounts.tokenExpiresAt })
      .from(socialAccounts)
      .where(eq(socialAccounts.id, account.id));
    if (!row) throw new PublishError('auth', AUTH_LOST_MESSAGE, 'accountMissing');
    const markLost = () =>
      deps.db
        .update(socialAccounts)
        .set({ status: 'reauth_required', updatedAt: new Date() })
        .where(eq(socialAccounts.id, account.id));
    if (!row.tokensEnc) {
      await markLost();
      throw new PublishError('auth', AUTH_LOST_MESSAGE, 'noTokens');
    }
    const tokens = tryDecrypt(key, row.tokensEnc);
    if (!tokens) {
      await markLost();
      throw new PublishError('auth', AUTH_LOST_MESSAGE, 'decrypt');
    }
    if (row.tokenExpiresAt && row.tokenExpiresAt.getTime() >= Date.now() + 60_000) return tokens.accessToken;

    if (!tokens.refreshToken) {
      await markLost();
      throw new PublishError('auth', AUTH_LOST_MESSAGE, 'noRefreshToken');
    }
    const provider = requireProvider(deps, account.platform);
    let fresh: Awaited<ReturnType<OAuthProvider['refresh']>>;
    try {
      fresh = await provider.refresh(tokens.refreshToken);
    } catch (e) {
      if (e instanceof PublishError && e.reason === 'auth') await markLost();
      throw e;
    }
    await deps.db
      .update(socialAccounts)
      .set({
        tokensEnc: encryptJson(key, {
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken ?? tokens.refreshToken,
        } satisfies StoredTokens),
        tokenExpiresAt: fresh.expiresAt,
        scopes: fresh.scopes,
        updatedAt: new Date(),
      })
      .where(eq(socialAccounts.id, account.id));
    return fresh.accessToken;
  };
}
