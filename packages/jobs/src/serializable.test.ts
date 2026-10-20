import { describe, expect, it } from 'vitest';
import { assertSerializablePayload } from './index';

describe('assertSerializablePayload', () => {
  it('accepts plain JSON values', () => {
    expect(() =>
      assertSerializablePayload({ projectId: 'a', n: 1, flags: [true, null], nested: { s: 'x' } }),
    ).not.toThrow();
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const bad: [string, unknown][] = [
    ['Buffer', { buf: Buffer.from('x') }],
    ['function', { fn: () => 1 }],
    ['Date', { d: new Date() }],
    ['Map', { m: new Map() }],
    ['NaN', { n: NaN }],
    ['undefined', { u: undefined }],
    ['bigint', { big: 1n }],
    ['cycle', cyclic],
  ];
  it.each(bad)('rejects %s with INVALID_PAYLOAD', (_name, payload) => {
    expect(() => assertSerializablePayload(payload)).toThrow(expect.objectContaining({ code: 'INVALID_PAYLOAD' }));
  });
});
