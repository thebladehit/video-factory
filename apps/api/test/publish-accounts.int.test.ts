import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { publications, renders, socialAccounts, users } from '@vf/db';
import { createFakeOAuth, PublishError } from '@vf/publish';
import { appRouter } from '../src/index';
import { accessTokenFor } from '../src/modules/publish/accounts';
import { registerOAuthRoutes } from '../src/modules/publish/oauth-route';
import { start, type Started } from './publish-helpers';

const TOKEN_FIELDS = ['tokensEnc', 'tokenExpiresAt', 'scopes', 'accessToken', 'refreshToken'];

/** connectUrl → «згода» fake-OAuth → GET callback; повертає Location */
async function connect(s: Started, language: string) {
  const { url } = await s.caller.publish.accounts.connectUrl({ platform: 'youtube', language });
  const u = new URL(url);
  expect(u.pathname).toBe('/oauth/youtube/callback');
  const res = await s.server.inject({ method: 'GET', url: u.pathname + u.search });
  expect(res.statusCode).toBe(302);
  return String(res.headers.location);
}

const accountRow = async (s: Started, id: string) =>
  (await s.deps.db.select().from(socialAccounts).where(eq(socialAccounts.id, id)))[0]!;

describe('publish.accounts', () => {
  it('createManual tiktok uk → listed without tokens fields', async () => {
    const s = await start();
    const created = await s.caller.publish.accounts.createManual({
      platform: 'tiktok',
      name: '  Мій TikTok ',
      language: 'uk',
      profileUrl: 'https://www.tiktok.com/@me',
    });
    expect(created).toMatchObject({ platform: 'tiktok', method: 'manual', name: 'Мій TikTok', language: 'uk' });
    const list = await s.caller.publish.accounts.list();
    expect(list.youtubeConfigured).toBe(true);
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]).toMatchObject({
      id: created.id,
      status: 'active',
      profileUrl: 'https://www.tiktok.com/@me',
    });
    for (const f of TOKEN_FIELDS) expect(list.accounts[0]).not.toHaveProperty(f);

    const updated = await s.caller.publish.accounts.update({ id: created.id, name: 'Інший', language: 'en' });
    expect(updated).toMatchObject({ name: 'Інший', language: 'en' });
    await expect(
      s.caller.publish.accounts.createManual({ platform: 'tiktok', name: 'x', language: 'xx' }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    await s.caller.publish.accounts.remove({ id: created.id });
    expect((await s.caller.publish.accounts.list()).accounts).toHaveLength(0);
  });

  it('connectUrl → fake url; GET callback → 302 ?connected=<id>, account active with tokens, list has no tokens', async () => {
    const s = await start();
    const location = await connect(s, 'uk');
    const m = /\/publications\?connected=([\w-]+)$/.exec(location);
    expect(location.startsWith(s.deps.publish.redirectBase)).toBe(true);
    expect(m).not.toBeNull();
    const row = await accountRow(s, m![1]!);
    expect(row).toMatchObject({
      userId: s.userId,
      platform: 'youtube',
      method: 'api',
      status: 'active',
      language: 'uk',
      externalId: 'fake-channel',
      name: 'Тестовий канал',
    });
    expect(row.tokensEnc).toMatch(/^v1\./);
    expect(row.tokensEnc).not.toContain('fake-access');
    expect(row.tokenExpiresAt).toBeInstanceOf(Date);
    const { accounts } = await s.caller.publish.accounts.list();
    expect(accounts).toHaveLength(1);
    for (const f of TOKEN_FIELDS) expect(accounts[0]).not.toHaveProperty(f);
    expect(JSON.stringify(accounts)).not.toContain('v1.');
  });

  it('callback twice for same channel → one account, language updated', async () => {
    const s = await start();
    const first = await connect(s, 'uk');
    await s.deps.db
      .update(socialAccounts)
      .set({ status: 'reauth_required' })
      .where(eq(socialAccounts.userId, s.userId));
    const second = await connect(s, 'en');
    expect(second).toBe(first);
    const { accounts } = await s.caller.publish.accounts.list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ language: 'en', status: 'active' });
  });

  it('callback with error=access_denied → ?connectError=denied', async () => {
    const s = await start();
    const res = await s.server.inject({ method: 'GET', url: '/oauth/youtube/callback?error=access_denied&state=x' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${s.deps.publish.redirectBase}/publications?connectError=denied`);
    const bad = await s.server.inject({ method: 'GET', url: '/oauth/youtube/callback?code=fake&state=forged' });
    expect(bad.headers.location).toBe(`${s.deps.publish.redirectBase}/publications?connectError=state`);
    expect((await s.caller.publish.accounts.list()).accounts).toHaveLength(0);
  });

  it('callback when channel is missing → ?connectError=noChannel', async () => {
    const s = await start();
    s.deps.publish.oauth.youtube = {
      ...createFakeOAuth(),
      exchange: () =>
        Promise.reject(new PublishError('auth', 'На цьому Google-акаунті немає YouTube-каналу', 'noChannel')),
    };
    expect(await connect(s, 'uk')).toBe(`${s.deps.publish.redirectBase}/publications?connectError=noChannel`);
  });

  it('callback when YouTube is not configured on server → ?connectError=notConfigured', async () => {
    const s = await start();
    const { url } = await s.caller.publish.accounts.connectUrl({ platform: 'youtube', language: 'uk' });
    s.deps.publish.oauth.youtube = undefined;
    const u = new URL(url);
    const res = await s.server.inject({ method: 'GET', url: u.pathname + u.search });
    expect(res.headers.location).toBe(`${s.deps.publish.redirectBase}/publications?connectError=notConfigured`);
  });

  it('callback keeps code and state out of request logs', async () => {
    const s = await start();
    // окремий сервер із журналом у пам'ять (у тестах журнал основного сервера вимкнено)
    const lines: string[] = [];
    const logged = Fastify({ logger: { level: 'info', stream: { write: (l: string) => void lines.push(l) } } });
    registerOAuthRoutes(logged, s.deps);
    const { url } = await s.caller.publish.accounts.connectUrl({ platform: 'youtube', language: 'uk' });
    const u = new URL(url);
    const res = await logged.inject({ method: 'GET', url: u.pathname + u.search });
    await logged.close();
    expect(res.statusCode).toBe(302);
    const log = lines.join('\n');
    expect(log).not.toContain(u.searchParams.get('state')!);
    expect(log).not.toContain('code=');
  });

  it('callback whose exchange fails → ?connectError=exchange', async () => {
    const oauth = { ...createFakeOAuth(), exchange: () => Promise.reject(new PublishError('other', 'boom')) };
    const s = await start({ publishFake: true }, {});
    s.deps.publish.oauth.youtube = oauth;
    const location = await connect(s, 'uk');
    expect(location).toBe(`${s.deps.publish.redirectBase}/publications?connectError=exchange`);
  });

  it('remove account with live publication → CONFLICT', async () => {
    const s = await start();
    const acc = await s.caller.publish.accounts.createManual({ platform: 'instagram', name: 'Інста', language: 'uk' });
    const { id: projectId } = await s.caller.projects.create({ title: 'Ролик', format: '9:16' });
    const p = await s.caller.projects.get({ id: projectId });
    const [r] = await s.deps.db
      .insert(renders)
      .values({
        userId: s.userId,
        projectId,
        preset: 'final',
        timelineSnapshot: p.timeline,
        timelineVersion: p.version,
        status: 'done',
      })
      .returning();
    const [pub] = await s.deps.db
      .insert(publications)
      .values({
        userId: s.userId,
        projectId,
        renderId: r!.id,
        language: 'uk',
        platform: 'instagram',
        accountId: acc.id,
        method: 'manual',
        status: 'awaiting_manual',
        metadata: { title: '', description: 'Підпис', tags: [] },
      })
      .returning();
    await expect(s.caller.publish.accounts.remove({ id: acc.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Акаунт має публікації в роботі',
    });
    expect((await s.caller.publish.accounts.list()).accounts).toHaveLength(1);

    // після кінцевого стану — видаляється разом з публікаціями
    await s.deps.db.update(publications).set({ status: 'published' }).where(eq(publications.id, pub!.id));
    await s.caller.publish.accounts.remove({ id: acc.id });
    expect((await s.caller.publish.accounts.list()).accounts).toHaveLength(0);
  });

  it("another user's account → NOT_FOUND", async () => {
    const s = await start();
    const acc = await s.caller.publish.accounts.createManual({ platform: 'facebook', name: 'FB', language: 'uk' });
    const [o] = await s.deps.db.insert(users).values({ name: 'Чужий' }).returning();
    const stranger = appRouter.createCaller({ userId: o!.id, deps: s.deps });
    await expect(stranger.publish.accounts.update({ id: acc.id, name: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(stranger.publish.accounts.remove({ id: acc.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await stranger.publish.accounts.list()).accounts).toHaveLength(0);
  });

  it('youtubeConfigured false when no client id and not fake', async () => {
    const s = await start({ publishFake: false, youtube: { audited: false } });
    const list = await s.caller.publish.accounts.list();
    expect(list).toMatchObject({ youtubeConfigured: false, youtubeAudited: false });
    await expect(s.caller.publish.accounts.connectUrl({ platform: 'youtube', language: 'uk' })).rejects.toMatchObject({
      cause: { code: 'VALIDATION' },
    });
  });

  it('accessTokenFor refreshes expiring token and persists it', async () => {
    const s = await start();
    const id = /connected=([\w-]+)/.exec(await connect(s, 'uk'))![1]!;
    const before = await accountRow(s, id);
    await s.deps.db
      .update(socialAccounts)
      .set({ tokenExpiresAt: new Date(Date.now() + 30_000) })
      .where(eq(socialAccounts.id, id));
    expect(await accessTokenFor(s.deps, { id, platform: 'youtube' })()).toBe('fake-access');
    const after = await accountRow(s, id);
    expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(after.tokensEnc).not.toBe(before.tokensEnc);
  });

  it('accessTokenFor with undecryptable tokens → PublishError auth, account reauth_required', async () => {
    const s = await start();
    const id = /connected=([\w-]+)/.exec(await connect(s, 'uk'))![1]!;
    await s.deps.db.update(socialAccounts).set({ tokensEnc: 'v1.broken.tokens.x' }).where(eq(socialAccounts.id, id));
    const err = await accessTokenFor(s.deps, { id, platform: 'youtube' })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err).toMatchObject({ reason: 'auth', platformReason: 'decrypt' });
    expect((await accountRow(s, id)).status).toBe('reauth_required');
  });

  it('reconnect with undecryptable stored tokens and no new refresh token → active again', async () => {
    const s = await start();
    const id = /connected=([\w-]+)/.exec(await connect(s, 'uk'))![1]!;
    await s.deps.db
      .update(socialAccounts)
      .set({ tokensEnc: 'v1.broken.tokens.x', status: 'reauth_required' })
      .where(eq(socialAccounts.id, id));
    const fake = createFakeOAuth();
    s.deps.publish.oauth.youtube = {
      ...fake,
      exchange: async (code, uri) => ({ ...(await fake.exchange(code, uri)), refreshToken: undefined }),
    };
    expect(await connect(s, 'uk')).toBe(`${s.deps.publish.redirectBase}/publications?connected=${id}`);
    expect((await accountRow(s, id)).status).toBe('active');
  });

  it('accessTokenFor with fake oauth whose refresh throws auth → account reauth_required', async () => {
    const s = await start();
    const id = /connected=([\w-]+)/.exec(await connect(s, 'uk'))![1]!;
    s.deps.publish.oauth.youtube = {
      ...createFakeOAuth(),
      refresh: () => Promise.reject(new PublishError('auth', 'invalid_grant', 'invalid_grant')),
    };
    await s.deps.db
      .update(socialAccounts)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(socialAccounts.id, id));
    await expect(accessTokenFor(s.deps, { id, platform: 'youtube' })()).rejects.toMatchObject({ reason: 'auth' });
    expect((await accountRow(s, id)).status).toBe('reauth_required');
  });
});
