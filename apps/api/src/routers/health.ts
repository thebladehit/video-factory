import { procedure, router } from '../trpc';

const within = (p: Promise<unknown>, ms: number) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]).then(
    () => 'up' as const,
    () => 'down' as const,
  );

export const healthRouter = router({
  check: procedure.query(async ({ ctx }) => {
    const [db, storage, media] = await Promise.all([
      within(ctx.deps.dbPing(), 2000),
      within(ctx.deps.storage.ping(), 2500),
      ctx.deps.mediaPing().then((ok) => (ok ? ('up' as const) : ('down' as const))),
    ]);
    // сховище піднялося після старту API — створюємо бакет і CORS зараз
    if (storage === 'up') await ctx.deps.bucket.ensure().catch(() => {});
    return { db, storage, media };
  }),
});
