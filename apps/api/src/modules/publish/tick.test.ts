import { describe, expect, it } from 'vitest';
import { planTick, type TickRow } from './tick';

const now = new Date('2026-10-23T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const row = (patch: Partial<TickRow>): TickRow => ({
  id: 'p1',
  userId: 'u1',
  platform: 'youtube',
  method: 'api',
  status: 'scheduled',
  scheduledAt: null,
  updatedAt: now,
  processingSince: null,
  jobLive: false,
  ...patch,
});
const empty = { toAwaiting: [], toEnqueue: [], toPoll: [], toTimeout: [] };

describe('planTick', () => {
  it('manual scheduled past → toAwaiting', () => {
    const plan = planTick([row({ method: 'manual', platform: 'tiktok', scheduledAt: ago(1000) })], now);
    expect(plan).toEqual({ ...empty, toAwaiting: ['p1'] });
  });

  it('manual scheduled future → nothing', () => {
    const plan = planTick([row({ method: 'manual', platform: 'tiktok', scheduledAt: ago(-60_000) })], now);
    expect(plan).toEqual(empty);
  });

  it('api scheduled future without job → toEnqueue', () => {
    // для API scheduled_at — час виходу на платформі, завантаження починається одразу
    const plan = planTick([row({ scheduledAt: ago(-86_400_000) })], now);
    expect(plan).toEqual({ ...empty, toEnqueue: ['p1'] });
  });

  it('api scheduled with live job → nothing', () => {
    expect(planTick([row({ jobLive: true })], now)).toEqual(empty);
  });

  it('processing updated 30 s ago → no poll; 61 s → poll', () => {
    const processing = { status: 'processing' as const, processingSince: ago(120_000) };
    expect(planTick([row({ ...processing, updatedAt: ago(30_000) })], now)).toEqual(empty);
    expect(planTick([row({ ...processing, updatedAt: ago(61_000) })], now)).toEqual({ ...empty, toPoll: ['p1'] });
  });

  it('short tick (e2e, 2 s) → poll throttle follows the tick interval', () => {
    const processing = { status: 'processing' as const, processingSince: ago(10_000) };
    expect(planTick([row({ ...processing, updatedAt: ago(1_000) })], now, 2_000)).toEqual(empty);
    expect(planTick([row({ ...processing, updatedAt: ago(2_000) })], now, 2_000)).toEqual({
      ...empty,
      toPoll: ['p1'],
    });
    // довший за хвилину тік не послаблює обмеження «раз на 60 с»
    expect(planTick([row({ ...processing, updatedAt: ago(61_000) })], now, 300_000)).toEqual({
      ...empty,
      toPoll: ['p1'],
    });
  });

  it('processing since 2 h 1 min → toTimeout', () => {
    const plan = planTick(
      [row({ status: 'processing', processingSince: ago(121 * 60_000), updatedAt: ago(61_000) })],
      now,
    );
    expect(plan).toEqual({ ...empty, toTimeout: ['p1'] });
  });
});
