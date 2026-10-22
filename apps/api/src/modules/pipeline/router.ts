import { z } from 'zod';
import type { PipelineSettings } from '@vf/shared';
import { procedure, router } from '../../trpc';
import { addScene, deleteScene, moveScene, regenerateSceneText, updateScene } from './scenes';
import { cancelPipeline, continuePipeline, estimate, getPipeline, retryPipeline, startPipeline } from './service';

// перевірку налаштувань робить сервіс (pipelineSettingsSchema) — помилка VALIDATION українською
const settings = z.unknown() as unknown as z.ZodType<PipelineSettings>;
const projectId = z.string();
const sceneId = z.string();

export const pipelineRouter = router({
  estimate: procedure.input(settings).query(({ ctx, input }) => estimate(ctx.deps, ctx.userId, input)),
  start: procedure.input(settings).mutation(({ ctx, input }) => startPipeline(ctx.deps, ctx.userId, input)),
  get: procedure
    .input(z.object({ projectId }))
    .query(({ ctx, input }) => getPipeline(ctx.deps, ctx.userId, input.projectId)),
  updateScene: procedure
    .input(
      z.object({
        sceneId,
        narration: z.string().optional(),
        visualPrompt: z.string().optional(),
        keywords: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateScene(ctx.deps, ctx.userId, input)),
  addScene: procedure
    .input(z.object({ projectId, after: z.string().optional(), narration: z.string() }))
    .mutation(({ ctx, input }) => addScene(ctx.deps, ctx.userId, input)),
  deleteScene: procedure
    .input(z.object({ sceneId }))
    .mutation(({ ctx, input }) => deleteScene(ctx.deps, ctx.userId, input.sceneId)),
  moveScene: procedure
    .input(z.object({ sceneId, position: z.number().int() }))
    .mutation(({ ctx, input }) => moveScene(ctx.deps, ctx.userId, input)),
  continue: procedure
    .input(z.object({ projectId }))
    .mutation(({ ctx, input }) => continuePipeline(ctx.deps, ctx.userId, input.projectId)),
  // part 'visual' — разом із pipeline.visual (T8)
  regenerateScene: procedure
    .input(z.object({ sceneId, part: z.literal('text') }))
    .mutation(({ ctx, input }) => regenerateSceneText(ctx.deps, ctx.userId, input.sceneId)),
  cancel: procedure
    .input(z.object({ projectId }))
    .mutation(({ ctx, input }) => cancelPipeline(ctx.deps, ctx.userId, input.projectId)),
  retry: procedure
    .input(z.object({ projectId }))
    .mutation(({ ctx, input }) => retryPipeline(ctx.deps, ctx.userId, input.projectId)),
});
