import { describe, expect, it } from 'vitest';
import { videoTarget } from './video-sync';

const clip = (o: Partial<{ start: number; duration: number; in: number; speed: number; hold: number }> = {}) => ({
  start: 0,
  duration: 10,
  in: 0,
  ...o,
});

describe('videoTarget', () => {
  it('inside the source: play from sourceTime at normal rate', () => {
    expect(videoTarget(clip({ start: 1, in: 0.2 }), 2, 4, 30)).toEqual({ time: 1.2, paused: false, playbackRate: 1 });
  });
  it('past the real end of the source: hold the last frame, never play (play() on an ended element restarts at 0)', () => {
    const t = videoTarget(clip(), 4.02, 4, 30);
    expect(t.paused).toBe(true);
    expect(t.time).toBeLessThan(4);
    expect(t.time).toBeGreaterThan(4 - 1 / 30);
  });
  it('within the last frame of the source: hold', () => {
    expect(videoTarget(clip(), 3.99, 4, 30).paused).toBe(true);
  });
  it('unknown duration (metadata not loaded): play', () => {
    expect(videoTarget(clip(), 2, NaN, 30)).toEqual({ time: 2, paused: false, playbackRate: 1 });
  });

  describe('speed 0.8, hold 0.5', () => {
    const c = clip({ start: 2, duration: 3, in: 1, speed: 0.8, hold: 0.5 });
    it('before the hold zone: plays at playbackRate 0.8 from in + local × speed', () => {
      const r = videoTarget(c, 3, 100, 30);
      expect(r.paused).toBe(false);
      expect(r.playbackRate).toBe(0.8);
      expect(r.time).toBeCloseTo(1 + 1 * 0.8, 9);
    });
    it('in the hold zone: paused on the last decoded frame, in + (duration − hold) × speed − 1/fps (as the render)', () => {
      const last = 1 + (3 - 0.5) * 0.8 - 1 / 30;
      for (const t of [4.5, 4.7, 4.99]) {
        const r = videoTarget(c, t, 100, 30);
        expect(r.paused).toBe(true);
        expect(r.time).toBeCloseTo(last, 9);
      }
    });
    it('hold frame never goes before in', () => {
      const tiny = clip({ duration: 0.5, in: 3, speed: 0.8, hold: 0.49 });
      expect(videoTarget(tiny, 0.495, 100, 30)).toMatchObject({ paused: true, time: 3 });
    });
  });
});
