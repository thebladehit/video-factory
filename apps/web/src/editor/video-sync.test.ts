import { describe, expect, it } from 'vitest';
import { videoTarget } from './video-sync';

describe('videoTarget', () => {
  it('inside the source: play from sourceTime', () => {
    expect(videoTarget(1.2, 4, 30)).toEqual({ time: 1.2, hold: false });
  });
  it('past the real end of the source: hold the last frame, never play (play() on an ended element restarts at 0)', () => {
    const t = videoTarget(4.02, 4, 30);
    expect(t.hold).toBe(true);
    expect(t.time).toBeLessThan(4);
    expect(t.time).toBeGreaterThan(4 - 1 / 30);
  });
  it('within the last frame: hold', () => {
    expect(videoTarget(3.99, 4, 30).hold).toBe(true);
  });
  it('unknown duration (metadata not loaded): play', () => {
    expect(videoTarget(2, NaN, 30)).toEqual({ time: 2, hold: false });
  });
});
