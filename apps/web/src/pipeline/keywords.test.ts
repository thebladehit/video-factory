import { describe, expect, it } from 'vitest';
import { keywordsToSave, parseKeywords } from './keywords';

describe('keywords', () => {
  it('parseKeywords trims, drops empties and duplicates, caps at 8', () => {
    expect(parseKeywords(' море , ,гори, море')).toEqual(['море', 'гори']);
    expect(parseKeywords('a,b,c,d,e,f,g,h,i')).toHaveLength(8);
  });

  it('keywordsToSave skips empty input and the value already committed (Enter then blur)', () => {
    expect(keywordsToSave(' , ', 'море')).toBeNull();
    expect(keywordsToSave('море, гори', 'море')).toEqual(['море', 'гори']);
    // Enter відправив «море, гори» → наступний blur з тим самим текстом нічого не шле
    expect(keywordsToSave('море, гори ', 'море, гори')).toBeNull();
  });
});
