import { assets, renders, users } from '@vf/db';
import type { AppConfig, AppDeps } from '../src/index';
import { appRouter } from '../src/index';
import { startApp } from './helpers';

/** Окремий користувач на тест: спільна тестова БД не заважає підрахункам акаунтів */
export async function start(patch: Partial<AppConfig> = { publishFake: true }, overrides: Partial<AppDeps> = {}) {
  let userId = '';
  const s = await startApp(patch, { auth: { authenticate: async () => ({ userId }) }, ...overrides });
  const [u] = await s.deps.db.insert(users).values({ name: 'Публікація' }).returning();
  userId = u!.id;
  return { ...s, userId, caller: appRouter.createCaller({ userId, deps: s.deps }) };
}

export type Started = Awaited<ReturnType<typeof start>>;

/** Проєкт + рендер (за замовчуванням готовий фінальний з файлом-результатом) */
export async function makeRender(
  s: Started,
  opts: {
    projectId?: string;
    title?: string;
    status?: 'done' | 'failed';
    preset?: 'final' | 'draft';
    language?: string | null;
    withAsset?: boolean;
  } = {},
) {
  const projectId =
    opts.projectId ?? (await s.caller.projects.create({ title: opts.title ?? 'Ролик', format: '9:16' })).id;
  const p = await s.caller.projects.get({ id: projectId });
  let assetId: string | null = null;
  if (opts.withAsset !== false) {
    const [a] = await s.deps.db
      .insert(assets)
      .values({
        userId: s.userId,
        kind: 'video',
        source: 'rendered',
        storageKey: `test/${crypto.randomUUID()}.mp4`,
        mime: 'video/mp4',
        durationMs: 12_000,
        title: opts.title ?? 'Ролик',
      })
      .returning();
    assetId = a!.id;
  }
  const [r] = await s.deps.db
    .insert(renders)
    .values({
      userId: s.userId,
      projectId,
      preset: opts.preset ?? 'final',
      language: opts.language ?? null,
      timelineSnapshot: p.timeline,
      timelineVersion: p.version,
      status: opts.status ?? 'done',
      outputAssetId: assetId,
      finishedAt: new Date(),
    })
    .returning();
  return { projectId, renderId: r!.id, assetId };
}
