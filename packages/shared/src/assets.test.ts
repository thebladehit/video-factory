import { describe, expect, it } from 'vitest';
import { assetKeys, normalizeTags, titleFromName, titleFromPrompt } from './assets';

describe('asset helpers', () => {
  it('normalizes tags', () => {
    expect(normalizeTags([' Кіт ', 'кіт', '', 'Space'])).toEqual(['кіт', 'space']);
    expect(normalizeTags(Array.from({ length: 31 }, (_, i) => `t${i}`))).toHaveLength(30);
    expect(normalizeTags(['x'.repeat(60)])[0]).toHaveLength(40);
  });

  it('builds S3 keys', () => {
    expect(assetKeys.original('u1', 'a1', 'png')).toBe('u/u1/assets/a1/original.png');
    expect(assetKeys.thumb('u1', 'a1')).toBe('u/u1/assets/a1/thumb.webp');
  });

  it('titles', () => {
    expect(titleFromName('Відпустка 2026.final.MP4')).toBe('Відпустка 2026.final');
    expect(titleFromPrompt('кіт у космосі')).toBe('кіт у космосі');
    const long = titleFromPrompt('слово '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith('…')).toBe(true);
  });
});
