import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutStorage } from './layout-storage';

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('layoutStorage', () => {
  it('returns a stored plain-object layout as is', () => {
    vi.stubGlobal('localStorage', memory({ k: '{"a":30,"b":70}' }));
    expect(layoutStorage.getItem('k')).toBe('{"a":30,"b":70}');
  });

  it('corrupt or non-object values → null (the panels library parses them unguarded)', () => {
    for (const v of ['{corrupt', '', 'null', '42', '"x"', '[1,2]', 'true']) {
      vi.stubGlobal('localStorage', memory({ k: v }));
      expect(layoutStorage.getItem('k')).toBeNull();
    }
  });

  it('missing key or throwing storage → null; setItem never throws', () => {
    vi.stubGlobal('localStorage', memory());
    expect(layoutStorage.getItem('k')).toBeNull();
    const boom = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom });
    expect(layoutStorage.getItem('k')).toBeNull();
    expect(() => layoutStorage.setItem('k', '{}')).not.toThrow();
  });
});
