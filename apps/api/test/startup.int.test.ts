import { describe, expect, it } from 'vitest';
import { createDb } from '@vf/db';
import { createPgJobStore } from '@vf/jobs';
import { LOCAL_USER_ID } from '@vf/shared';
import { createApp, loadConfig } from '../src/index';
import { testConfig } from './helpers';

describe('startup', () => {
  it('fails with a readable INFRA_UNAVAILABLE when Postgres is down', async () => {
    const err = await createApp(testConfig({ databaseUrl: 'postgres://vf:vf@localhost:1/vf' })).catch((e) => e);
    expect(err).toMatchObject({ code: 'INFRA_UNAVAILABLE' });
    expect(err.message).toContain('docker compose up -d');
  });

  it('tells to run migrations when the database is not migrated', async () => {
    const url = process.env.TEST_DATABASE_URL!.replace(/\/vf_test$/, '/postgres');
    const err = await createApp(testConfig({ databaseUrl: url })).catch((e) => e);
    expect(err).toMatchObject({ code: 'INFRA_UNAVAILABLE' });
    expect(err.message).toContain('pnpm db:migrate');
  });

  it('creates the local user on startup so a fresh database works without a manual seed', async () => {
    const { createDb, users } = await import('@vf/db');
    const { db, close } = createDb(process.env.TEST_DATABASE_URL!);
    await db.delete(users);
    const app = await createApp(testConfig());
    expect(await db.select().from(users)).toHaveLength(1);
    await app.close();
    await close();
  });

  it('loadConfig lists missing variables', () => {
    expect(() => loadConfig({})).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    try {
      loadConfig({});
    } catch (e) {
      expect((e as Error).message).toContain('DATABASE_URL');
      expect((e as Error).message).toContain('S3_BUCKET');
    }
  });
});

describe('job recovery', () => {
  it('does not touch running jobs until start() — a second instance that fails to bind must not fail them', async () => {
    const { db, close } = createDb(process.env.TEST_DATABASE_URL!);
    const store = createPgJobStore(db);
    const job = await store.insert({ userId: LOCAL_USER_ID, type: 'debug.sleep', payload: { durationMs: 100, steps: 1 } });
    await store.claim(job.id);

    const app = await createApp(testConfig());
    expect((await store.get(job.id))!.status).toBe('running');

    await app.start();
    expect((await store.get(job.id))!.status).toBe('failed');
    await app.close();
    await close();
  });
});
