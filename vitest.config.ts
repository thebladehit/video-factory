import { globSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// apps/web має Playwright-тести (*.spec.ts) — їх запускає Playwright, не Vitest
const projects = globSync(['packages/*/package.json', 'apps/api/package.json']).map((p) => p.replace('/package.json', ''));

export default defineConfig({
  test: {
    projects: projects.length ? projects : undefined,
    include: projects.length ? undefined : ['packages/**/*.test.ts'],
    setupFiles: ['dotenv/config'],
    passWithNoTests: true,
    // int-тести різних пакетів ділять одну тестову БД
    fileParallelism: false,
  },
});
