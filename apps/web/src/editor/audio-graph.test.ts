import type { AudioItem } from '@vf/timeline';
import { describe, expect, it } from 'vitest';
import { applyRate, audioTarget, envelopeAt, scheduleEnvelope } from './audio-graph';

function mockParam() {
  const calls: [string, ...number[]][] = [];
  const param = {
    cancelScheduledValues: (t: number) => calls.push(['cancel', t]),
    setValueAtTime: (v: number, t: number) => calls.push(['set', v, t]),
    linearRampToValueAtTime: (v: number, t: number) => calls.push(['ramp', v, t]),
  };
  return { param: param as unknown as AudioParam, calls };
}

const item = (o: Partial<AudioItem> = {}): AudioItem => ({
  clipId: 'a',
  assetId: 'x',
  start: 2,
  in: 1,
  duration: 4,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  speed: 1,
  hold: 0,
  envelope: [],
  ...o,
});

const duck = [
  { t: 0, gain: 1 },
  { t: 1, gain: 0.32 },
  { t: 2, gain: 0.32 },
  { t: 2.2, gain: 1 },
];

describe('envelopeAt', () => {
  it('no points → 1; before first / after last → their gain; linear between', () => {
    expect(envelopeAt([], 3)).toBe(1);
    expect(envelopeAt(duck, -1)).toBe(1);
    expect(envelopeAt(duck, 5)).toBe(1);
    expect(envelopeAt(duck, 0.5)).toBeCloseTo(0.66, 9);
    expect(envelopeAt(duck, 1.5)).toBeCloseTo(0.32, 9);
  });
});

describe('scheduleEnvelope', () => {
  it('ramps linearly to every point at clip start + t', () => {
    const { param, calls } = mockParam();
    scheduleEnvelope(param, duck, 10, 10);
    expect(calls).toEqual([
      ['cancel', 10],
      ['set', 1, 10],
      ['ramp', 0.32, 11],
      ['ramp', 0.32, 12],
      ['ramp', 1, 12.2],
    ]);
  });
  it('started mid-clip: current value now, only future points are ramped', () => {
    const { param, calls } = mockParam();
    scheduleEnvelope(param, duck, 10, 11.5);
    expect(calls).toEqual([
      ['cancel', 11.5],
      ['set', 0.32, 11.5],
      ['ramp', 0.32, 12],
      ['ramp', 1, 12.2],
    ]);
  });
  it('no envelope → constant 1', () => {
    const { param, calls } = mockParam();
    scheduleEnvelope(param, [], 10, 10.3);
    expect(calls).toEqual([
      ['cancel', 10.3],
      ['set', 1, 10.3],
    ]);
  });
});

describe('audioTarget', () => {
  it('original with speed: playbackRate = speed, source time in + local × speed', () => {
    expect(audioTarget(item({ speed: 1.25 }), 'original', 2)).toEqual({ active: true, time: 1 + 2 * 1.25, rate: 1.25 });
  });
  it('video clip own sound (no role) follows the clip speed', () => {
    expect(audioTarget(item({ speed: 0.8 }), undefined, 1).rate).toBe(0.8);
  });
  it('voiceover never changes speed', () => {
    expect(audioTarget(item({ speed: 0.8 }), 'voiceover', 2)).toEqual({ active: true, time: 3, rate: 1 });
  });
  it('silent in the hold zone and outside the clip', () => {
    const it2 = item({ speed: 0.8, hold: 0.5 });
    expect(audioTarget(it2, 'original', 3.4).active).toBe(true);
    expect(audioTarget(it2, 'original', 3.5).active).toBe(false);
    expect(audioTarget(it2, 'original', -0.1).active).toBe(false);
    expect(audioTarget(item(), 'music', 4).active).toBe(false);
  });
});

describe('applyRate', () => {
  it('sets playbackRate and keeps pitch', () => {
    const el = { playbackRate: 1, preservesPitch: false } as HTMLMediaElement;
    applyRate(el, 1.25);
    expect(el.playbackRate).toBe(1.25);
    expect(el.preservesPitch).toBe(true);
  });
});
