import { describe, expect, it } from 'vitest';
import { jobSubject, publicationMetaSchema } from './index';

describe('publicationMetaSchema', () => {
  it('accepts minimal {title:"",description:"",tags:[]}', () => {
    expect(publicationMetaSchema.safeParse({ title: '', description: '', tags: [] }).success).toBe(true);
  });

  it("rejects privacy 'secret'", () => {
    expect(
      publicationMetaSchema.safeParse({ title: '', description: '', tags: [], privacy: 'secret' }).success,
    ).toBe(false);
  });
});

describe('jobSubject', () => {
  it('picks publicationId', () => {
    expect(jobSubject({ publicationId: 'p1' })).toEqual({ publicationId: 'p1' });
  });
});
