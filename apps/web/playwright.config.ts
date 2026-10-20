import { defineConfig, devices } from '@playwright/test';

// e2e працюють на тестовій БД і окремих портах — робочі дані й запущений `pnpm dev` не зачіпаються
process.loadEnvFile(new URL('../../.env', import.meta.url));
const API_PORT = '3101';
const WEB_PORT = '5174';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @vf/api exec tsx src/main.ts',
      url: `http://localhost:${API_PORT}/trpc/health.check`,
      env: {
        AI_FAKE: '1',
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        API_PORT,
        WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @vf/web exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { VF_API_URL: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
