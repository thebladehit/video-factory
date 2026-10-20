import cors from '@fastify/cors';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';
import { createAiRegistry, createEnvCredentialStore, type AiRegistry } from '@vf/ai';
import { sql } from 'drizzle-orm';
import { createDb, seed, type Db } from '@vf/db';
import { createInProcessJobs, createPgJobStore, type JobQueue, type WorkerRuntime } from '@vf/jobs';
import { AppError } from '@vf/shared';
import { createS3BlobStorage, type BlobStorage } from '@vf/storage';
import { singleUserAuth, type AuthProvider } from './auth/single-user';
import type { AppConfig } from './config';
import { debugSleep } from './jobs/debug-sleep';
import { appRouter, type AppRouter } from './routers';

export interface AppDeps {
  db: Db;
  dbPing: () => Promise<void>;
  storage: BlobStorage;
  jobs: { queue: JobQueue; runtime: WorkerRuntime };
  ai: AiRegistry;
  auth: AuthProvider;
}

/** Composition root: єдине місце, де інтерфейси отримують реалізації. */
export async function createApp(cfg: AppConfig, overrides: Partial<AppDeps> = {}) {
  const dbHandle = createDb(cfg.databaseUrl);
  try {
    await dbHandle.ping();
  } catch (e) {
    await dbHandle.close();
    throw new AppError(
      'INFRA_UNAVAILABLE',
      `Postgres недоступний за DATABASE_URL (${(e as Error).message}). Запустіть: docker compose up -d`,
    );
  }
  const [migrated] = await dbHandle.db.execute<{ t: string | null }>(sql`select to_regclass('public.jobs') as t`);
  if (!migrated?.t) {
    await dbHandle.close();
    throw new AppError('INFRA_UNAVAILABLE', 'База даних не мігрована. Виконайте: pnpm db:migrate');
  }
  // v1: локальний користувач має існувати без ручного кроку (ідемпотентно)
  await seed(dbHandle.db);

  const server = Fastify({ logger: !process.env.VITEST, routerOptions: { maxParamLength: 5000 } });
  const storage = overrides.storage ?? createS3BlobStorage(cfg.s3);
  try {
    await Promise.race([
      storage.ensureBucket({ corsOrigins: [cfg.webOrigin] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch (e) {
    server.log.warn({ err: e }, 'S3-сховище недоступне — завантаження файлів не працюватимуть');
  }

  const deps: AppDeps = {
    db: dbHandle.db,
    dbPing: dbHandle.ping,
    storage,
    ai:
      overrides.ai ??
      createAiRegistry({ credentials: createEnvCredentialStore({ ...process.env, AI_FAKE: cfg.aiFake ? '1' : '' }) }),
    jobs: overrides.jobs ?? createInProcessJobs(createPgJobStore(dbHandle.db)),
    auth: overrides.auth ?? singleUserAuth,
    ...overrides,
  };
  deps.jobs.runtime.register(debugSleep);

  await server.register(cors, { origin: cfg.webOrigin });
  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async ({ req }) => ({ userId: (await deps.auth.authenticate(req)).userId, deps }),
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  return {
    server,
    deps,
    /**
     * Запускає воркери й відновлення задач. Викликати лише після успішного listen():
     * зайнятий порт = вже працює інший екземпляр, і його задачі не можна чіпати.
     */
    start: () => deps.jobs.runtime.start(),
    async close() {
      await deps.jobs.runtime.stop();
      await server.close();
      await dbHandle.close();
    },
  };
}
