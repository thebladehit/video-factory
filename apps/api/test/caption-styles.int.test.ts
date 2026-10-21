import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '@vf/captions';
import { appRouter } from '../src/index';
import { startApp } from './helpers';

const style = () => structuredClone(PRESETS[0]!.style);

describe('captionStyles', () => {
  it('list starts with the four presets', async () => {
    const { caller } = await startApp();
    const list = await caller.captionStyles.list();
    expect(list.filter((s) => s.preset).map((s) => s.id)).toEqual([
      'preset:shorts',
      'preset:pop',
      'preset:karaoke',
      'preset:classic',
    ]);
  });

  it('create → list → update → delete', async () => {
    const { caller } = await startApp();
    const created = await caller.captionStyles.create({ name: '  Мій  ', style: style() });
    expect(created).toMatchObject({ name: 'Мій', preset: false });
    expect((await caller.captionStyles.list()).some((s) => s.id === created.id)).toBe(true);

    const updated = await caller.captionStyles.update({
      id: created.id,
      name: 'Новий',
      style: { ...style(), color: '#112233' },
    });
    expect(updated).toMatchObject({ name: 'Новий', style: { color: '#112233' } });

    await caller.captionStyles.delete({ id: created.id });
    expect((await caller.captionStyles.list()).some((s) => s.id === created.id)).toBe(false);
    await expect(caller.captionStyles.delete({ id: created.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('invalid colour → VALIDATION and nothing is stored', async () => {
    const { caller } = await startApp();
    const before = (await caller.captionStyles.list()).length;
    await expect(
      caller.captionStyles.create({ name: 'Поганий', style: { ...style(), color: 'red' } }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    const ok = await caller.captionStyles.create({ name: 'Добрий', style: style() });
    await expect(
      caller.captionStyles.update({ id: ok.id, style: { ...style(), activeColor: '#12' } }),
    ).rejects.toMatchObject({ cause: { code: 'VALIDATION' } });
    expect((await caller.captionStyles.list()).length).toBe(before + 1);
  });

  it("another user's style → NOT_FOUND and invisible", async () => {
    const s = await startApp();
    const mine = await s.caller.captionStyles.create({ name: 'Мій', style: style() });
    const stranger = appRouter.createCaller({ userId: randomUUID(), deps: s.deps });
    await expect(stranger.captionStyles.update({ id: mine.id, name: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(stranger.captionStyles.delete({ id: mine.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await stranger.captionStyles.list()).some((x) => x.id === mine.id)).toBe(false);
  });
});
