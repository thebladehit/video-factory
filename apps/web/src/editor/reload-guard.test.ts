import { describe, expect, it } from 'vitest';
import { emptyTimeline } from '@vf/shared';
import { canReplaceDoc } from './reload-guard';

describe('canReplaceDoc', () => {
  const a = emptyTimeline('9:16');
  it('allows replacing an untouched document', () => expect(canReplaceDoc(a, a, false)).toBe(true));
  it('refuses when the document changed during the fetch', () => expect(canReplaceDoc(a, { ...a }, false)).toBe(false));
  it('refuses when autosave has pending changes', () => expect(canReplaceDoc(a, a, true)).toBe(false));
});
