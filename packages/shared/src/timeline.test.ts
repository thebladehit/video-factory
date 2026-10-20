import { describe, expect, it } from 'vitest';
import { emptyTimeline, timelineDocSchema } from './index';

const validDoc = () => ({
  schemaVersion: 1,
  width: 1080,
  height: 1920,
  fps: 30,
  tracks: [
    {
      id: 't1',
      kind: 'video',
      clips: [
        { id: 'c1', assetId: 'a1', start: 0, duration: 2, in: 0, fit: 'cover', effects: [{ type: 'kenburns', params: {} }] },
      ],
    },
  ],
});

describe('timelineDocSchema', () => {
  it('emptyTimeline(9:16) is valid with expected dimensions', () => {
    const doc = timelineDocSchema.parse(emptyTimeline('9:16'));
    expect(doc).toMatchObject({ width: 1080, height: 1920, fps: 30, tracks: [] });
  });

  it('accepts a video track with a clip', () => {
    expect(timelineDocSchema.safeParse(validDoc()).success).toBe(true);
  });

  const mutations: [string, (d: any) => void][] = [
    ['duration 0', (d) => (d.tracks[0].clips[0].duration = 0)],
    ['negative start', (d) => (d.tracks[0].clips[0].start = -1)],
    ['negative in', (d) => (d.tracks[0].clips[0].in = -0.5)],
    ['unknown track kind', (d) => (d.tracks[0].kind = 'subtitle')],
    ['captions track without language', (d) => d.tracks.push({ id: 't2', kind: 'captions', clips: [] })],
    ['schemaVersion 2', (d) => (d.schemaVersion = 2)],
    ['unknown effect', (d) => (d.tracks[0].clips[0].effects = [{ type: 'glitch', params: {} }])],
  ];
  it.each(mutations)('rejects %s', (_name, mutate) => {
    const doc = validDoc();
    mutate(doc);
    expect(timelineDocSchema.safeParse(doc).success).toBe(false);
  });
});
