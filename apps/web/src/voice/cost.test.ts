import { describe, expect, it } from 'vitest';
import { formatFit, formatUsd } from './cost';

const fit = (p: Partial<Parameters<typeof formatFit>[0]>) => ({
  segmentId: 's',
  base: 4.1,
  target: 4.1,
  speed: 1,
  used: 4.1,
  hold: 0,
  trimmed: 0,
  ...p,
});

describe('formatFit', () => {
  it('рівно — без підгонки', () => {
    expect(formatFit(fit({}), 'en')).toBe('база 4,1 с → EN 4,1 с');
  });
  it('темп і стоп-кадр', () => {
    expect(formatFit(fit({ target: 5.3, speed: 0.8, hold: 0.2 }), 'en')).toBe(
      'база 4,1 с → EN 5,3 с (темп ×0,8 + стоп-кадр 0,2 с)',
    );
  });
  it('темп ×1,25 і обрізаний хвіст', () => {
    expect(formatFit(fit({ base: 10, target: 4.2, speed: 1.25, used: 5.25, trimmed: 4.75 }), 'de')).toBe(
      'база 10,0 с → DE 4,2 с (темп ×1,25 + обрізано 4,8 с)',
    );
  });
  it('лише темп у межах', () => {
    expect(formatFit(fit({ target: 4.4, speed: 0.93 }), 'en')).toBe('база 4,1 с → EN 4,4 с (темп ×0,93)');
  });
});

describe('formatUsd', () => {
  it('центи', () => {
    expect(formatUsd(0.123)).toBe('$0.12');
    expect(formatUsd(0)).toBe('$0.00');
  });
});
