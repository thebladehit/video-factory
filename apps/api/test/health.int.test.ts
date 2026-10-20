import { describe, expect, it } from 'vitest';
import { startApp, testConfig } from './helpers';

describe('health.check', () => {
  it('reports db and storage up', async () => {
    const { caller } = await startApp();
    expect(await caller.health.check()).toEqual({ db: 'up', storage: 'up' });
  });

  it('starts and reports storage down when S3 is unreachable', async () => {
    const { caller } = await startApp({ s3: { ...testConfig().s3, endpoint: 'http://localhost:1' } });
    const started = Date.now();
    expect(await caller.health.check()).toEqual({ db: 'up', storage: 'down' });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
