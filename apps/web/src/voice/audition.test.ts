import { describe, expect, it } from 'vitest';
import { estimateAudition, pickCandidates, runQueue, type TtsCatalogEntry } from './audition';

const entry = (ref: string, voices: string[], usd = 0.015, available = true): TtsCatalogEntry => ({
  ref,
  capability: 'tts',
  available,
  voices: voices.map((id) => ({ id, name: id })),
  pricing: [{ unit: 'minute', usd }],
});

describe('pickCandidates', () => {
  it('keeps listed candidates of available models only', () => {
    const c = pickCandidates([
      entry('openai/gpt-4o-mini-tts', ['marin', 'cedar', 'ash', 'coral']),
      entry('google/gemini-3.8-flash-tts', ['Kore'], 0.01, false),
    ]);
    expect(c.map((x) => x.voiceId)).toEqual(['marin', 'cedar', 'ash', 'coral']);
  });
  it('falls back to up to 4 voices of the first available tts model', () => {
    const c = pickCandidates([entry('fake/tts', ['a', 'b', 'c', 'd', 'e'], 0)]);
    expect(c.map((x) => x.voiceId)).toEqual(['a', 'b', 'c', 'd']);
    expect(pickCandidates([])).toEqual([]);
  });
});

describe('estimateAudition', () => {
  it('chars / 15 s × price per minute × 2 takes × candidates', () => {
    const cat = [entry('openai/gpt-4o-mini-tts', ['marin'], 0.6)];
    const c = [{ model: 'openai/gpt-4o-mini-tts' as never, voiceId: 'marin' }];
    expect(estimateAudition(cat, c, 150)).toBeCloseTo(((10 * 0.6) / 60) * 2);
    expect(estimateAudition(cat, [...c, ...c], 150)).toBeCloseTo(((10 * 0.6) / 60) * 4);
  });
});

describe('runQueue', () => {
  it('never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    await runQueue([...Array(10).keys()], 3, async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBe(3);
  });

  it('stops taking new items once shouldContinue is false (in-flight ones finish)', async () => {
    const started: number[] = [];
    let open = true;
    await runQueue(
      [...Array(10).keys()],
      3,
      async (i) => {
        started.push(i);
        if (i === 1) open = false; // діалог закрито, поки йдуть перші запити
        await new Promise((r) => setTimeout(r, 5));
      },
      { shouldContinue: () => open },
    );
    expect(started).toEqual([0, 1]);
  });
});
