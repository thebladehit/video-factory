import { describe, expect, it } from 'vitest';
import { createApp, loadConfig } from '../src/index';
import { testConfig } from './helpers';

describe('startup', () => {
  it('fails with a readable INFRA_UNAVAILABLE when Postgres is down', async () => {
    const err = await createApp(testConfig({ databaseUrl: 'postgres://vf:vf@localhost:1/vf' })).catch((e) => e);
    expect(err).toMatchObject({ code: 'INFRA_UNAVAILABLE' });
    expect(err.message).toContain('docker compose up -d');
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
