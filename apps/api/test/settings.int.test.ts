import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { userSettings } from '@vf/db';
import { LOCAL_USER_ID } from '@vf/shared';
import { startApp } from './helpers';

describe('settings', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  beforeEach(async () => {
    ctx = await startApp();
    await ctx.deps.db.update(userSettings).set({ defaults: {}, channelStyle: '' }).where(eq(userSettings.userId, LOCAL_USER_ID));
  });

  it('saves a default model', async () => {
    await ctx.caller.settings.setDefault({ capability: 'text', ref: 'fake/text' });
    expect((await ctx.caller.settings.get()).defaults.text).toEqual({ ref: 'fake/text', available: true });
  });

  it('rejects a model of another capability', async () => {
    await expect(ctx.caller.settings.setDefault({ capability: 'text', ref: 'fake/image' })).rejects.toMatchObject({
      cause: { code: 'MODEL_NOT_FOUND' },
    });
  });

  it('rejects a model without a key', async () => {
    await expect(
      ctx.caller.settings.setDefault({ capability: 'text', ref: 'anthropic/claude-sonnet-5-5' }),
    ).rejects.toMatchObject({ cause: { code: 'MODEL_UNAVAILABLE' } });
  });

  it('reports a stale saved default as unavailable instead of failing', async () => {
    await ctx.deps.db
      .update(userSettings)
      .set({ defaults: { text: 'openai/gone-model' } })
      .where(eq(userSettings.userId, LOCAL_USER_ID));
    const s = await ctx.caller.settings.get();
    expect(s.defaults.text).toEqual({ ref: 'openai/gone-model', available: false });
    expect(s.defaults.image).toBeNull();
  });

  it('saves channel style', async () => {
    await ctx.caller.settings.setChannelStyle({ text: 'Коротко, з гумором' });
    expect((await ctx.caller.settings.get()).channelStyle).toBe('Коротко, з гумором');
  });
});
