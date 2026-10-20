import { LOCAL_USER_ID } from '@vf/shared';
import { afterEach } from 'vitest';
import { createApp, loadConfig, appRouter, type AppConfig, type AppDeps } from '../src/index';

export const testConfig = (patch: Partial<AppConfig> = {}): AppConfig => ({
  ...loadConfig({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }),
  aiFake: true,
  ...patch,
});

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()));
});

export async function startApp(patch: Partial<AppConfig> = {}, overrides: Partial<AppDeps> = {}) {
  const app = await createApp(testConfig(patch), overrides);
  opened.push(app);
  const caller = appRouter.createCaller({ userId: LOCAL_USER_ID, deps: app.deps });
  return { ...app, caller };
}
