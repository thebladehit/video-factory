import { describe, expect, it } from 'vitest';
import { formatForCopy } from './copy';

describe('formatForCopy', () => {
  it('youtube', () => {
    expect(formatForCopy('youtube', { title: 'Title', description: 'Desc', tags: ['a', 'b'] })).toBe(
      'Title\n\nDesc\n\nТеги: a, b',
    );
  });
  it('tiktok', () => {
    expect(formatForCopy('tiktok', { title: '', description: 'Desc', tags: ['a', 'b'] })).toBe('Desc\n\n#a #b');
  });
  it('не дублює # у тегах', () => {
    expect(formatForCopy('instagram', { title: '', description: 'D', tags: ['#a', 'b'] })).toBe('D\n\n#a #b');
    expect(formatForCopy('youtube', { title: 'T', description: 'D', tags: ['#a'] })).toBe('T\n\nD\n\nТеги: a');
  });
});
