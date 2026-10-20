import { describe, expect, it } from 'vitest';
import { parseProgress } from './progress';

describe('parseProgress', () => {
  it('out_time_us → percent of the duration', () => {
    expect(parseProgress('frame=10\nout_time_us=2500000\nprogress=continue\n', 10)).toBe(25);
  });
  it('takes the last value in the chunk and caps at 100', () => {
    expect(parseProgress('out_time_us=1000000\nout_time_us=30000000\n', 10)).toBe(100);
  });
  it('progress=end is 100', () => {
    expect(parseProgress('progress=end\n', 10)).toBe(100);
  });
  it('null without time', () => {
    expect(parseProgress('frame=1\nfps=0.0\n', 10)).toBeNull();
  });
});
