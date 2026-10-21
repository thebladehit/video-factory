import { describe, expect, it } from 'vitest';
import { buildTranslatePrompt, translateSchema } from './translate';

describe('translate prompt', () => {
  const p = buildTranslatePrompt({
    from: 'uk',
    to: 'en',
    items: [{ id: 's1', text: 'Привіт' }],
    context: ['Раніше речення'],
  });
  it('includes languages, ids, texts and context', () => {
    expect(p.system).toContain('uk');
    expect(p.system).toContain('en');
    expect(p.prompt).toContain('s1');
    expect(p.prompt).toContain('Привіт');
    expect(p.prompt).toContain('Раніше речення');
  });
  it('schema requires items with id and text', () => {
    expect(translateSchema.safeParse({ items: [{ id: 'a', text: 'b' }] }).success).toBe(true);
    expect(translateSchema.safeParse({ items: [{ id: 'a' }] }).success).toBe(false);
  });
});
