import { describe, expect, it } from 'vitest';
import { buildPublishMetaPrompt, publishMetaSchema } from './publish-meta';

const limits = {
  youtube: { title: 100, titleRequired: true, description: 5000, descriptionBytes: true, tagsTotal: 500 },
  tiktok: { title: 0, titleRequired: false, description: 2200 },
  instagram: { title: 0, titleRequired: false, description: 2200, hashtags: 30 },
  facebook: { title: 255, titleRequired: false, description: 5000 },
};
const base = { title: 'Ролик', language: 'en', format: '9:16', narration: ['Hello'], limits };

describe('publish meta prompt', () => {
  it('prompt mentions language and all four platforms', () => {
    const p = buildPublishMetaPrompt(base);
    expect(p.system).toContain('en');
    expect(p.prompt).toContain('en');
    for (const name of ['youtube', 'tiktok', 'instagram', 'facebook']) expect(p.system).toContain(name);
    expect(p.system).toContain('100');
    expect(p.system).toContain('2200');
  });
  it('narration of 10 000 chars is cut to 6000', () => {
    const p = buildPublishMetaPrompt({ ...base, narration: ['§'.repeat(5000), '¶'.repeat(5000)] });
    expect(p.prompt.match(/[§¶]/g)).toHaveLength(5999); // 6000 з урахуванням переносу між рядками
  });
  it('9:16 mentions Shorts, 16:9 does not', () => {
    expect(buildPublishMetaPrompt(base).system).toContain('Shorts');
    expect(buildPublishMetaPrompt({ ...base, format: '16:9' }).system).not.toContain('Shorts');
  });
  it('without narration falls back to title and topic', () => {
    const p = buildPublishMetaPrompt({ ...base, narration: [], topic: 'Космос' });
    expect(p.prompt).toContain('Космос');
    expect(p.prompt).toContain('Тексту озвучки немає');
  });
  it('schema requires all four platforms', () => {
    expect(publishMetaSchema.safeParse({ youtube: { title: '', description: '', tags: [] } }).success).toBe(false);
  });
});
