import cors from '@fastify/cors';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';
import { createAiRegistry, createEnvCredentialStore, type AiRegistry } from '@vf/ai';
import { sql } from 'drizzle-orm';
import { createDb, seed, type Db } from '@vf/db';
import {
  createInProcessJobs,
  createIntervalScheduler,
  createPgJobStore,
  type JobQueue,
  type WorkerRuntime,
} from '@vf/jobs';
import { AppError } from '@vf/shared';
import { checkTools, type MediaTools } from '@vf/media';
import { createFfmpegRenderer, type Renderer } from '@vf/render';
import { createLazyBucket, createS3BlobStorage, type BlobStorage } from '@vf/storage';
import { singleUserAuth, type AuthProvider } from './auth/single-user';
import type { AppConfig } from './config';
import { debugSleep } from './jobs/debug-sleep';
import { cleanupStaleUploads } from './modules/assets/cleanup';
import { assetAnalyzeJob } from './modules/assets/analyze-job';
import { assetProcessJob } from './modules/assets/process-job';
import { reconcileAfterRestart } from './modules/recovery';
import { assetsTagJob } from './modules/assets/tag-job';
import { imageGenerateJob } from './modules/generate/image-job';
import { videoGenerateJob } from './modules/generate/video-job';
import { assembleJob } from './modules/pipeline/assemble-job';
import { pipelineEvents } from './modules/pipeline/events';
import { sceneJob } from './modules/pipeline/scene-job';
import { scriptJob } from './modules/pipeline/script-job';
import { visualJob } from './modules/pipeline/visual-job';
import { renderJob } from './modules/renders/render-job';
import { releaseOnCancel, synthesizeJob } from './modules/voice/synthesize-job';
import { transcribeJob } from './modules/voice/transcribe-job';
import { translateJob } from './modules/voice/translate-job';
import { tagAfterProcess } from './modules/assets/tagger';
import { appRouter, type AppRouter } from './routers';

export interface AppDeps {
  db: Db;
  dbPing: () => Promise<void>;
  storage: BlobStorage;
  /** Бакет і CORS створюються при першій потребі (якщо на старті S3 був недоступний) */
  bucket: { ensure(): Promise<void> };
  media: MediaTools;
  /** ffmpeg/ffprobe доступні (кеш 30 с) */
  mediaPing: () => Promise<boolean>;
  jobs: { queue: JobQueue; runtime: WorkerRuntime };
  ai: AiRegistry;
  auth: AuthProvider;
  renderer: Renderer;
  /** Журнал сервера (фонові помилки, які не повертаються клієнту) */
  log: { error(obj: object, msg?: string): void };
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
  const bucket = createLazyBucket(storage, { corsOrigins: [cfg.webOrigin] });
  const media: MediaTools = { ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath };
  let mediaCheck: { at: number; ok: Promise<boolean> } | null = null;
  const mediaPing = () => {
    if (!mediaCheck || Date.now() - mediaCheck.at > 30_000) mediaCheck = { at: Date.now(), ok: checkTools(media) };
    return mediaCheck.ok;
  };
  if (!(await mediaPing())) server.log.warn('FFmpeg/ffprobe недоступні — обробка медіа не працюватиме');
  try {
    await Promise.race([
      bucket.ensure(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch (e) {
    server.log.warn({ err: e }, 'S3-сховище недоступне — завантаження файлів не працюватимуть');
  }

  const deps: AppDeps = {
    db: dbHandle.db,
    dbPing: dbHandle.ping,
    storage,
    bucket,
    media,
    mediaPing,
    ai:
      overrides.ai ??
      createAiRegistry({
        credentials: createEnvCredentialStore({ ...process.env, AI_FAKE: cfg.aiFake ? '1' : '' }),
        media: { ffmpegPath: cfg.ffmpegPath, ffprobePath: cfg.ffprobePath },
      }),
    jobs: overrides.jobs ?? createInProcessJobs(createPgJobStore(dbHandle.db)),
    auth: overrides.auth ?? singleUserAuth,
    renderer: overrides.renderer ?? createFfmpegRenderer(media),
    log: overrides.log ?? server.log,
    ...overrides,
  };
  deps.jobs.runtime.register(debugSleep);
  deps.jobs.runtime.register(assetProcessJob(deps, tagAfterProcess));
  deps.jobs.runtime.register(assetAnalyzeJob(deps));
  deps.jobs.runtime.register(assetsTagJob(deps));
  deps.jobs.runtime.register(imageGenerateJob(deps));
  deps.jobs.runtime.register(renderJob(deps, { fontsDir: cfg.captionsFontsDir }));
  deps.jobs.runtime.register(videoGenerateJob(deps, { pollMs: cfg.videoPollMs, timeoutMs: cfg.videoTimeoutMs }));
  deps.jobs.runtime.register(synthesizeJob(deps));
  deps.jobs.runtime.register(translateJob(deps));
  deps.jobs.runtime.register(transcribeJob(deps));
  deps.jobs.runtime.register(scriptJob(deps));
  deps.jobs.runtime.register(sceneJob(deps));
  deps.jobs.runtime.register(visualJob(deps));
  deps.jobs.runtime.register(assembleJob(deps));
  const offVoiceEvents = deps.jobs.queue.onEvent(releaseOnCancel(deps));
  const offPipelineEvents = deps.jobs.queue.onEvent(pipelineEvents(deps));
  const scheduler = createIntervalScheduler((msg, e) => server.log.error({ err: e }, msg));

  await server.register(cors, { origin: cfg.webOrigin });
  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async ({ req }) => ({ userId: (await deps.auth.authenticate(req)).userId, deps }),
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  let closed = false;
  return {
    server,
    deps,
    /**
     * Запускає воркери й відновлення задач. Викликати лише після успішного listen():
     * зайнятий порт = вже працює інший екземпляр, і його задачі не можна чіпати.
     */
    async start() {
      await deps.jobs.runtime.start();
      await reconcileAfterRestart(deps);
      scheduler.every('assets.cleanup', 3_600_000, async () => void (await cleanupStaleUploads(deps)), {
        runOnStart: true,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      scheduler.stop();
      // перервані зупинкою задачі запусків доводить advance на наступному старті, не цей процес
      offPipelineEvents();
      await deps.jobs.runtime.stop();
      offVoiceEvents();
      await server.close();
      await dbHandle.close();
    },
  };
}
