import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson, signState, verifyState } from './crypto';

const key = randomBytes(32);
const payload = { userId: '00000000-0000-0000-0000-000000000001', language: 'uk', platform: 'youtube' as const };

describe('token crypto', () => {
  it('encrypt/decrypt round-trip', () => {
    const value = { accessToken: 'a', refreshToken: 'r' };
    const s = encryptJson(key, value);
    expect(s).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(s).not.toContain('refreshToken');
    expect(decryptJson(key, s)).toEqual(value);
    // випадковий iv — щоразу інший шифротекст
    expect(encryptJson(key, value)).not.toBe(s);
  });

  it('decrypt with other key throws', () => {
    const s = encryptJson(key, { accessToken: 'a' });
    expect(() => decryptJson(randomBytes(32), s)).toThrow();
  });
});

describe('oauth state', () => {
  it('state round-trip', () => {
    const now = new Date('2026-10-23T10:00:00Z');
    const s = signState(key, payload, now);
    expect(verifyState(key, s, new Date(now.getTime() + 9 * 60_000))).toEqual(payload);
  });

  it('state after 10 min + 1 s → VALIDATION', () => {
    const now = new Date('2026-10-23T10:00:00Z');
    const s = signState(key, payload, now);
    expect(() => verifyState(key, s, new Date(now.getTime() + 10 * 60_000 + 1000))).toThrow(
      expect.objectContaining({ code: 'VALIDATION', message: 'Посилання підключення застаріло — спробуйте ще раз' }),
    );
  });

  it('tampered state → VALIDATION', () => {
    const s = signState(key, payload);
    const [body, sig] = s.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), userId: 'other' }),
    ).toString('base64url');
    for (const bad of [`${forged}.${sig}`, `${body}.${sig}x`, 'garbage', '', signState(randomBytes(32), payload)]) {
      expect(() => verifyState(key, bad)).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    }
  });
});
