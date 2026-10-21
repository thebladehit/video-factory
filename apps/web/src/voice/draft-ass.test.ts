import { describe, expect, it } from 'vitest';
import { PRESETS, toAss } from '@vf/captions';
import { emptyTimeline, type TimelineDoc } from '@vf/shared';
import { draftSubtitles } from './draft-ass';

const doc = (): TimelineDoc => ({
  ...emptyTimeline('9:16'),
  tracks: [
    {
      id: 'a',
      kind: 'audio',
      role: 'voiceover',
      language: 'uk',
      clips: [{ id: 'va', assetId: 'x', start: 1, in: 0, duration: 2, volume: 1 }],
    } as never,
    {
      id: 'c',
      kind: 'captions',
      language: 'uk',
      clips: [{ id: 'cc', audioClipId: 'va', transcriptId: 't', styleId: 'preset:classic' }],
    } as never,
  ],
});
const transcripts = {
  t: {
    words: [
      { text: 'Привіт', startMs: 0, endMs: 400 },
      { text: 'світ', startMs: 500, endMs: 900 },
    ],
  },
};

describe('draftSubtitles', () => {
  it('returns null without caption tracks', () => {
    expect(draftSubtitles(emptyTimeline('9:16'), transcripts, PRESETS[0]!.style)).toBeNull();
  });

  it('renders the draft style instead of the saved one and finds the first page', () => {
    const shorts = PRESETS.find((p) => p.id === 'preset:shorts')!.style;
    const r = draftSubtitles(doc(), transcripts, { ...shorts, font: 'oswald', size: 9 })!;
    expect(r.ass).toContain('Oswald');
    expect(r.firstStart).toBeCloseTo(1, 3);
    // збережений стиль (classic) того самого документа дає інший ASS
    expect(toAss({ doc: doc(), transcripts, styles: {} })).not.toBe(r.ass);
  });
});
