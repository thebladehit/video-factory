import { describe, expect, it } from 'vitest';
import { toSrt, toVtt, type Page } from './index';

const pages: Page[] = [
  {
    lines: [
      [
        { text: 'Hello', startMs: 1250, endMs: 1600 },
        { text: 'world', startMs: 1700, endMs: 2000 },
      ],
    ],
    start: 1.25,
    end: 2,
  },
  {
    lines: [[{ text: 'two', startMs: 3600000, endMs: 3601000 }], [{ text: 'lines', startMs: 3601000, endMs: 3602500 }]],
    start: 3600,
    end: 3602.5,
  },
];

describe('toSrt / toVtt', () => {
  it('SRT numbers cues and uses comma milliseconds', () => {
    expect(toSrt(pages)).toBe(
      '1\n00:00:01,250 --> 00:00:02,000\nHello world\n\n2\n01:00:00,000 --> 01:00:02,500\ntwo\nlines\n',
    );
  });
  it('VTT has header and dot milliseconds', () => {
    expect(toVtt(pages)).toBe(
      'WEBVTT\n\n00:00:01.250 --> 00:00:02.000\nHello world\n\n01:00:00.000 --> 01:00:02.500\ntwo\nlines\n',
    );
  });
});
