import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @vf/api dev',
      url: 'http://localhost:3001/trpc/health.check',
      env: { AI_FAKE: '1' },
      reuseExistingServer: true,
      timeout: 60_000,
    },
    { command: 'pnpm --filter @vf/web dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
  ],
});
