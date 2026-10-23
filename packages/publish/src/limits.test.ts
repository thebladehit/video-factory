import { describe, expect, it } from 'vitest';
import type { PublicationMeta } from '@vf/shared';
import { clampMeta, validateMeta } from './limits';

const meta = (o: Partial<PublicationMeta> = {}): PublicationMeta => ({
  title: 'Назва',
  description: '',
  tags: [],
  ...o,
});

describe('validateMeta', () => {
  it('youtube: назва 101 символ', () => {
    expect(validateMeta('youtube', meta({ title: 'а'.repeat(101) }))).toEqual(['Назва довша за 100 символів']);
  });
  it('youtube: < у назві', () => {
    expect(validateMeta('youtube', meta({ title: 'a<b' })).length).toBe(1);
  });
  it('youtube: порожня назва', () => {
    expect(validateMeta('youtube', meta({ title: '' }))).toEqual(['Назва обов\'язкова']);
  });
  it('youtube: опис у байтах', () => {
    expect(validateMeta('youtube', meta({ description: 'я'.repeat(2500) }))).toEqual([]);
    expect(validateMeta('youtube', meta({ description: 'я'.repeat(2501) })).length).toBe(1);
  });
  it('youtube: теги разом > 500', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `tag${i}xxxxx`);
    expect(validateMeta('youtube', meta({ tags })).length).toBe(1);
  });
  it('instagram: 31 хештег', () => {
    const tags = Array.from({ length: 31 }, (_, i) => `t${i}`);
    expect(validateMeta('instagram', meta({ title: '', tags })).length).toBe(1);
    expect(validateMeta('instagram', meta({ title: '', tags: tags.slice(0, 30) }))).toEqual([]);
  });
  it('instagram: хештеги з # рахуються правильно', () => {
    const tags = Array.from({ length: 30 }, (_, i) => `#t${i}`);
    expect(validateMeta('instagram', meta({ title: '', tags }))).toEqual([]);
  });
  it('tiktok: порожня назва ок', () => {
    expect(validateMeta('tiktok', meta({ title: '' }))).toEqual([]);
  });
});

describe('clampMeta', () => {
  it('youtube: назва 120 символів → ≤100 по межі слова', () => {
    const title = Array.from({ length: 30 }, () => 'слово').join(' ');
    const out = clampMeta('youtube', meta({ title }));
    expect(out.title.length).toBeLessThanOrEqual(100);
    expect(out.title.endsWith('слово')).toBe(true);
    expect(title.startsWith(out.title)).toBe(true);
  });
  it('youtube: прибирає < та >', () => {
    expect(clampMeta('youtube', meta({ title: 'a<b>c' })).title).toBe('abc');
  });
  it('відкидає теги з кінця, поки разом ≤ 500', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `tag${String(i).padStart(2, '0')}xxxxx`);
    const out = clampMeta('youtube', meta({ tags }));
    expect(validateMeta('youtube', out)).toEqual([]);
    expect(out.tags.length).toBeLessThan(60);
    expect(out.tags).toEqual(tags.slice(0, out.tags.length));
  });
  it('youtube: опис обрізається до 5000 байтів', () => {
    const out = clampMeta('youtube', meta({ description: 'я'.repeat(3000) }));
    expect(validateMeta('youtube', out)).toEqual([]);
  });
});
