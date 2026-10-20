import { execSync } from 'node:child_process';

// Playwright зупиняє лише клієнт `docker compose up` — сам контейнер api-e2e лишився б працювати
export default function teardown() {
  execSync('docker compose --profile e2e stop api-e2e', { cwd: new URL('../../..', import.meta.url), stdio: 'ignore' });
}
