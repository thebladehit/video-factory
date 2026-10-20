import { globSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// apps/web має Playwright-тести (*.spec.ts) — їх запускає Playwright, не Vitest; з web беремо лише src/**/*.test.ts
const roots = globSync(['packages/*/package.json', 'apps/api/package.json']).map((p) => dirname(p));
const webProject = { extends: true, test: { name: 'web', root: resolve('apps/web'), include: ['src/**/*.test.ts'] } };

export default defineConfig({
  test: {
    // extends: true — проєкти успадковують setupFiles/passWithNoTests/fileParallelism з кореня
    ...(roots.length
      ? {
          projects: [
            ...roots.map((root) => ({ extends: true, test: { name: basename(root), root: resolve(root) } })),
            webProject,
          ],
        }
      : { include: ['packages/**/*.test.ts'] }),
    setupFiles: [resolve('vitest.setup.ts')],
    globalSetup: [resolve('packages/db/test/global-setup.ts')],
    passWithNoTests: true,
    // int-тести різних пакетів ділять одну тестову БД
    fileParallelism: false,
  },
});
