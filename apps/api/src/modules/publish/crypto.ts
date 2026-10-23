import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, type Platform } from '@vf/shared';

const ALGO = 'aes-256-gcm';
const STATE_TTL_MS = 10 * 60_000;
const STATE_EXPIRED = 'Посилання підключення застаріло — спробуйте ще раз';

/** Ключ для fake-режиму без TOKEN_ENCRYPTION_KEY (лише розробка й e2e — справжніх токенів там немає) */
export const FAKE_TOKEN_KEY = Buffer.alloc(32, 7);

/** AES-256-GCM: `v1.<iv>.<tag>.<data>` (base64url) */
export function encryptJson(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptJson<T>(key: Buffer, s: string): T {
  const [v, iv, tag, data] = s.split('.');
  try {
    if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('format');
    const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    // без деталей: у тексті помилки не має бути ані ключа, ані шифротексту
    throw new AppError('INTERNAL', 'Не вдалося розшифрувати токени — перепідключіть акаунт');
  }
}

export interface OAuthState {
  userId: string;
  language: string;
  platform: Platform;
}

// окремий HMAC-ключ, щоб не використовувати ключ шифрування для двох алгоритмів напряму
const stateMac = (key: Buffer, body: string) =>
  createHmac('sha256', createHmac('sha256', key).update('oauth-state').digest()).update(body).digest();

/** HMAC-підписаний `state` OAuth: `<payload>.<sig>`, живе 10 хв — таблиця станів не потрібна */
export function signState(key: Buffer, state: OAuthState, now = new Date()): string {
  const body = Buffer.from(
    JSON.stringify({ ...state, exp: now.getTime() + STATE_TTL_MS, nonce: randomBytes(8).toString('base64url') }),
  ).toString('base64url');
  return `${body}.${stateMac(key, body).toString('base64url')}`;
}

export function verifyState(key: Buffer, s: string, now = new Date()): OAuthState {
  const [body, sig, ...rest] = s.split('.');
  if (!body || !sig || rest.length) throw new AppError('VALIDATION', STATE_EXPIRED);
  const expected = stateMac(key, body);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected))
    throw new AppError('VALIDATION', STATE_EXPIRED);
  let p: OAuthState & { exp: number };
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState & { exp: number };
  } catch {
    throw new AppError('VALIDATION', STATE_EXPIRED);
  }
  if (typeof p.exp !== 'number' || now.getTime() > p.exp) throw new AppError('VALIDATION', STATE_EXPIRED);
  return { userId: p.userId, language: p.language, platform: p.platform };
}
