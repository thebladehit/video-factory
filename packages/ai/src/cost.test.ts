import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from './catalog';
import { estimateCost } from './cost';

const e = (pricing: CatalogEntry['pricing']): CatalogEntry => ({
  ref: 'fake/x',
  provider: 'fake',
  capability: 'image',
  label: 'x',
  pricing,
});

describe('estimateCost', () => {
  it('images × price', () => {
    expect(estimateCost(e([{ unit: 'image', usd: 0.04 }]), { images: 3 })).toBeCloseTo(0.12);
  });
  it('seconds × price', () => {
    expect(estimateCost(e([{ unit: 'second', usd: 0.1 }]), { seconds: 8 })).toBeCloseTo(0.8);
  });
  it('tokens in and out', () => {
    const entry = e([
      { unit: '1M_tokens_in', usd: 0.1 },
      { unit: '1M_tokens_out', usd: 0.5 },
    ]);
    expect(estimateCost(entry, { inputTokens: 1000, outputTokens: 200 })).toBeCloseTo((1000 * 0.1 + 200 * 0.5) / 1e6);
  });
  it('minutes: usd × durationSec / 60', () => {
    expect(estimateCost(e([{ unit: 'minute', usd: 0.015 }]), { durationSec: 120 })).toBeCloseTo(0.03);
  });
  it('null without pricing', () => {
    expect(estimateCost(e(undefined), { images: 1 })).toBeNull();
  });
  it('zero-priced fake models cost 0', () => {
    expect(estimateCost(e([{ unit: 'image', usd: 0 }]), { images: 2 })).toBe(0);
  });
});
