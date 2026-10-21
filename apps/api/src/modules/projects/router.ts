import { z } from 'zod';
import { FORMATS, type VideoFormat } from '@vf/shared';
import { procedure, router } from '../../trpc';
import { editorAssets } from './editor-assets';
import {
  createProject,
  deleteProject,
  duplicateProject,
  getProject,
  listProjects,
  renameProject,
  saveProject,
} from './service';

const byId = z.object({ id: z.string() });
const title = z.string().trim().min(1).max(200);
const format = z.enum(Object.keys(FORMATS) as [VideoFormat, ...VideoFormat[]]);

export const projectsRouter = router({
  list: procedure.query(({ ctx }) => listProjects(ctx.deps, ctx.userId)),
  create: procedure
    .input(z.object({ title, format }))
    .mutation(({ ctx, input }) => createProject(ctx.deps, ctx.userId, input)),
  get: procedure
    .input(z.object({ id: z.string(), language: z.string().optional() }))
    .query(({ ctx, input }) => getProject(ctx.deps, ctx.userId, input.id, input.language)),
  assets: procedure
    .input(z.object({ ids: z.array(z.string()).max(1000) }))
    .query(({ ctx, input }) => editorAssets(ctx.deps, ctx.userId, input.ids)),
  save: procedure
    .input(
      z.object({
        id: z.string(),
        language: z.string().optional(),
        timeline: z.unknown(),
        baseVersion: z.number().int().min(1),
      }),
    )
    .mutation(({ ctx, input }) => saveProject(ctx.deps, ctx.userId, input)),
  rename: procedure
    .input(z.object({ id: z.string(), title }))
    .mutation(({ ctx, input }) => renameProject(ctx.deps, ctx.userId, input)),
  duplicate: procedure.input(byId).mutation(({ ctx, input }) => duplicateProject(ctx.deps, ctx.userId, input.id)),
  delete: procedure.input(byId).mutation(({ ctx, input }) => deleteProject(ctx.deps, ctx.userId, input.id)),
});
