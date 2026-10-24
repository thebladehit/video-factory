import { describe, expect, it } from 'vitest';
import { blockingPublication, changedFields, mergeGenerated } from './dialog-state';

const pub = (status: string, renderId = 'r1', accountId = 'a1') =>
  ({ id: `${status}-${renderId}`, renderId, accountId, status }) as const;

describe('blockingPublication', () => {
  it('жива чи опублікована публікація цієї версії на цей акаунт блокує пару', () => {
    for (const s of ['scheduled', 'uploading', 'processing', 'awaiting_manual', 'published']) {
      expect(blockingPublication([pub(s)], 'r1', 'a1')?.status).toBe(s);
    }
  });

  it('кінцеві невдалі, інша версія чи інший акаунт — не блокують', () => {
    const list = [pub('failed'), pub('cancelled'), pub('published', 'r2'), pub('scheduled', 'r1', 'a2')];
    expect(blockingPublication(list, 'r1', 'a1')).toBeUndefined();
  });
});

describe('changedFields', () => {
  it('порівнює поля, зокрема масиви', () => {
    const a = { title: 'A', description: 'D', tags: ['x'] };
    expect(changedFields(a, { ...a, title: 'B' })).toEqual(['title']);
    expect(changedFields(a, { ...a, tags: ['x', 'y'] })).toEqual(['tags']);
    expect(changedFields(a, { ...a, tags: ['x'] })).toEqual([]);
  });
});

describe('mergeGenerated', () => {
  const variants = {
    youtube: { title: 'AI назва', description: 'AI опис', tags: ['ai'] },
    tiktok: { title: '', description: 'AI підпис', tags: [] },
  };

  it('без ручних змін — береться результат AI', () => {
    expect(mergeGenerated(variants, undefined, {})).toEqual(variants);
  });

  it('поля, які користувач уже змінив, лишаються його', () => {
    const current = { youtube: { title: 'Моя назва', description: '', tags: [] } };
    const merged = mergeGenerated(variants, current, { youtube: new Set(['title']) });
    expect(merged.youtube).toEqual({ title: 'Моя назва', description: 'AI опис', tags: ['ai'] });
    expect(merged.tiktok).toEqual(variants.tiktok);
  });
});
