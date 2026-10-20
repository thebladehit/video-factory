import { assetsRouter } from '../modules/assets/router';
import { generateRouter } from '../modules/generate/router';
import { router } from '../trpc';
import { aiRouter } from './ai';
import { healthRouter } from './health';
import { jobsRouter } from './jobs';
import { settingsRouter } from './settings';

export const appRouter = router({
  health: healthRouter,
  settings: settingsRouter,
  ai: aiRouter,
  jobs: jobsRouter,
  assets: assetsRouter,
  generate: generateRouter,
});

export type AppRouter = typeof appRouter;
