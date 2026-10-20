import { isAppError } from '@vf/shared';
import { createApp } from './app';
import { loadConfig } from './config';

try {
  const cfg = loadConfig(process.env);
  const app = await createApp(cfg);
  try {
    await app.server.listen({ port: cfg.apiPort, host: cfg.apiHost });
  } catch (e) {
    await app.close();
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    console.error(`\n✖ Порт ${cfg.apiPort} зайнятий — API вже запущено в іншому терміналі?\n`);
    process.exit(1);
  }
  await app.start();
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
