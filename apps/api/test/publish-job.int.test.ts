import { eq, inArray } from 'drizzle-orm';
import { createDb, assets, jobs, projects, publications, socialAccounts } from '@vf/db';
import {
  AUTH_LOST_MESSAGE,
  createFakeOAuth,
  createFakePublisher,
  PublishError,
  QUOTA_MESSAGE,
  type OAuthProvider,
  type Publisher,
  type UploadRequest,
} from '@vf/publish';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PublishDeps } from '../src/app';
import { encryptJson, FAKE_TOKEN_KEY } from '../src/modules/publish/crypto';
import { publishTick } from '../src/modules/publish/tick';
import { startApp, testConfig } from './helpers';
import { makeRender, start, type Started } from './publish-helpers';

const meta = { title: 'Назва', description: 'Опис', tags: [] as string[] };

function publishDeps(publisher: Publisher, oauth: OAuthProvider = createFakeOAuth()): PublishDeps {
  return {
    publishers: { youtube: publisher },
    oauth: { youtube: oauth },
    tokenKey: FAKE_TOKEN_KEY,
    redirectBase: 'http://localhost:5173',
    youtubeAudited: false,
  };
}

/** fake-публікатор із підміною upload */
function wrap(upload: (req: UploadRequest, fake: Publisher) => Promise<{ platformPostId: string; url: string }>) {
  const fake = createFakePublisher('youtube');
  return { ...fake, upload: (req: UploadRequest) => upload(req, fake) } satisfies Publisher;
}

/** Викликає onSession('s1') і чекає скасування задачі */
const hanging = () =>
  wrap(async (req) => {
    await req.onSession('s1');
    return new Promise((_, reject) => {
      if (req.signal.aborted) return reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  });

async function youtubeAccount(s: Started, opts: { expired?: boolean } = {}) {
  const [a] = await s.deps.db
    .insert(socialAccounts)
    .values({
      userId: s.userId,
      platform: 'youtube',
      method: 'api',
      name: 'Канал',
      language: 'uk',
      externalId: `c-${crypto.randomUUID()}`,
      tokensEnc: encryptJson(FAKE_TOKEN_KEY, { accessToken: 'a', refreshToken: 'r' }),
      tokenExpiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 3_600_000)),
    })
    .returning();
  return a!;
}

/** Готовий рендер із невеликим файлом у сховищі */
async function video(s: Started) {
  const r = await makeRender(s);
  const [a] = await s.deps.db.select().from(assets).where(eq(assets.id, r.assetId!));
  const bytes = Buffer.from('fake mp4 bytes');
  await s.deps.storage.put(a!.storageKey, bytes, { contentType: 'video/mp4' });
  await s.deps.db.update(assets).set({ sizeBytes: bytes.length }).where(eq(assets.id, a!.id));
  return r;
}

const pubRow = async (s: { deps: Started['deps'] }, id: string) =>
  (await s.deps.db.select().from(publications).where(eq(publications.id, id)))[0]!;

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const waitStatus = (s: { deps: Started['deps'] }, id: string, status: string) =>
  until(
    () => pubRow(s, id),
    (r) => r.status === status,
  );

// спільна тестова БД: живі api-публікації інших тестів не мають потрапляти до наших публікаторів
beforeEach(async () => {
  const h = createDb(testConfig().databaseUrl);
  await h.db
    .update(publications)
    .set({ status: 'cancelled' })
    .where(inArray(publications.status, ['scheduled', 'uploading', 'processing']));
  await h.close();
});

describe('publish job', () => {
  it('create youtube now → job → processing with url; publishTick → published; projects.status published', async () => {
    const s = await start();
    const acc = await youtubeAccount(s);
    const { renderId, projectId } = await video(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta }] });
    const row = await waitStatus(s, id!, 'processing');
    expect(row.url).toMatch(/^https:\/\/www\.youtube\.com\/shorts\/fake-/);
    expect(row).toMatchObject({ uploadSession: null, error: null });
    expect(row.platformPostId).toMatch(/^fake-/);
    expect(row.processingSince).not.toBeNull();
    expect((await s.deps.db.select().from(jobs).where(eq(jobs.id, row.jobId!)))[0]?.status).toBe('done');

    await publishTick(s.deps, new Date(Date.now() + 61_000));
    const done = await pubRow(s, id!);
    expect(done.status).toBe('published');
    expect(done.publishedAt).not.toBeNull();
    const [p] = await s.deps.db.select().from(projects).where(eq(projects.id, projectId));
    expect(p!.status).toBe('published');
  });

  it('scheduled in 1 day → upload gets publishAt', async () => {
    const seen: UploadRequest[] = [];
    const s = await start(undefined, {
      publish: publishDeps(
        wrap((req, fake) => {
          seen.push(req);
          return fake.upload(req);
        }),
      ),
    });
    const acc = await youtubeAccount(s);
    const { renderId } = await video(s);
    const at = new Date(Date.now() + 86_400_000);
    const [id] = await s.caller.publish.create({
      items: [{ renderId, accountId: acc.id, meta, scheduledAt: at.toISOString() }],
    });
    await waitStatus(s, id!, 'processing');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.publishAt?.toISOString()).toBe(at.toISOString());
    expect(seen[0]!.resume).toBeUndefined();
  });

  it('publisher throws PublishError quota → failed with quota message; retry → scheduled → job again', async () => {
    let calls = 0;
    const s = await start(undefined, {
      publish: publishDeps(
        wrap(async (req, fake) => {
          calls++;
          if (calls === 1) throw new PublishError('quota', 'quota', 'quotaExceeded');
          return fake.upload(req);
        }),
      ),
    });
    const acc = await youtubeAccount(s);
    const { renderId } = await video(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta }] });
    const failed = await waitStatus(s, id!, 'failed');
    expect(failed.error).toBe(QUOTA_MESSAGE);
    const job = await until(
      async () => (await s.deps.db.select().from(jobs).where(eq(jobs.id, failed.jobId!)))[0]!,
      (j) => j.status === 'failed',
    );
    expect(job.error).toBe(QUOTA_MESSAGE);

    await s.caller.publish.retry({ id: id! });
    const again = await waitStatus(s, id!, 'processing');
    expect(again.jobId).not.toBe(failed.jobId);
    expect(again.error).toBeNull();
    expect(calls).toBe(2);
  });

  it('restart mid-upload → new app resumes the same upload session', async () => {
    const s1 = await start(undefined, { publish: publishDeps(hanging()) });
    const acc = await youtubeAccount(s1);
    const { renderId } = await video(s1);
    const [id] = await s1.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta }] });
    await until(
      () => pubRow(s1, id!),
      (r) => r.status === 'uploading' && r.uploadSession === 's1',
    );
    await s1.close();

    const resumes: (string | undefined)[] = [];
    const s2 = await startApp(
      { publishFake: true },
      {
        auth: { authenticate: async () => ({ userId: s1.userId }) },
        publish: publishDeps(
          wrap((req, fake) => {
            resumes.push(req.resume);
            return fake.upload(req);
          }),
        ),
      },
    );
    const row = await waitStatus(s2, id!, 'processing');
    expect(resumes).toEqual(['s1']);
    expect(row.uploadSession).toBeNull();
  });

  it('accessTokenFor throws auth → publication failed with reauth message, account reauth_required, another manual publication untouched', async () => {
    const oauth: OAuthProvider = {
      ...createFakeOAuth(),
      refresh: async () => {
        throw new PublishError('auth', AUTH_LOST_MESSAGE, 'invalid_grant');
      },
    };
    const s = await start(undefined, {
      publish: publishDeps(
        wrap(async (req, fake) => {
          await req.tokens();
          return fake.upload(req);
        }),
        oauth,
      ),
    });
    const manual = await s.caller.publish.accounts.createManual({ platform: 'tiktok', name: 'TT', language: 'uk' });
    const m = await makeRender(s);
    const [manualId] = await s.caller.publish.create({
      items: [{ renderId: m.renderId, accountId: manual.id, meta: { title: '', description: 'Підпис', tags: [] } }],
    });
    const acc = await youtubeAccount(s, { expired: true });
    const { renderId } = await video(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta }] });
    const failed = await waitStatus(s, id!, 'failed');
    expect(failed.error).toBe(AUTH_LOST_MESSAGE);
    const [a] = await s.deps.db.select().from(socialAccounts).where(eq(socialAccounts.id, acc.id));
    expect(a!.status).toBe('reauth_required');
    expect((await pubRow(s, manualId!)).status).toBe('awaiting_manual');
  });

  it('cancel during uploading → cancelled, job cancelled', async () => {
    const s = await start(undefined, { publish: publishDeps(hanging()) });
    const acc = await youtubeAccount(s);
    const { renderId } = await video(s);
    const [id] = await s.caller.publish.create({ items: [{ renderId, accountId: acc.id, meta }] });
    const uploading = await until(
      () => pubRow(s, id!),
      (r) => r.status === 'uploading' && r.uploadSession === 's1',
    );
    await s.caller.publish.cancel({ id: id! });
    const job = await until(
      async () => (await s.deps.db.select().from(jobs).where(eq(jobs.id, uploading.jobId!)))[0]!,
      (j) => j.status === 'cancelled',
    );
    expect(job.status).toBe('cancelled');
    expect((await pubRow(s, id!)).status).toBe('cancelled');
  });
});
