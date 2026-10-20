import { isAppError } from '@vf/shared';
import { createApp } from './app';
import { loadConfig } from './config';

try {
  const cfg = loadConfig(process.env);
  const app = await createApp(cfg);
  await app.server.listen({ port: cfg.apiPort, host: '127.0.0.1' });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (e) {
  if (!isAppError(e)) throw e;
  console.error(`\n✖ ${e.message}\n`);
  process.exit(1);
}
