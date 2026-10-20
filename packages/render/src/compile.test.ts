import { describe, expect, it } from 'vitest';
import { emptyTimeline, type TimelineDoc } from '@vf/shared';
import { addClip, coverRect, evalExpr, setEffect, setTransition, setVolume, type AssetInfo } from '@vf/timeline';
import { compileFfmpeg, outputSize, transformFilter, type SourceInfo } from './index';

let n = 0;
const ids = () => `c${++n}`;
const src = (assetId: string, kind: SourceInfo['kind'], extra: Partial<SourceInfo> = {}): [string, SourceInfo] => [
  assetId,
  {
    path: `/w/${assetId}`,
    kind,
    width: kind === 'audio' ? undefined : 640,
    height: kind === 'audio' ? undefined : 360,
    hasAudio: kind !== 'image',
    ...extra,
  },
];
const add = (doc: TimelineDoc, a: AssetInfo, at: number) => addClip(doc, a, { at }, ids);
const compile = (doc: TimelineDoc, sources: [string, SourceInfo][], preset: 'final' | 'draft' = 'draft') =>
  compileFfmpeg({ doc, preset, sources: new Map(sources), filterScriptPath: '/w/graph.txt', outPath: '/w/out.mp4' });

/** Аргументи кожного `-i` разом з опціями перед ним. */
function inputs(args: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-i') {
      out.push([...cur, '-i', args[i + 1]!]);
      cur = [];
      i++;
    } else if (['-ss', '-t', '-loop', '-framerate'].includes(args[i]!)) {
      cur.push(args[i]!, args[i + 1]!);
      i++;
    } else cur = [];
  }
  return out;
}

describe('compileFfmpeg', () => {
  const photo: AssetInfo = { id: 'P', kind: 'image' };
  const video: AssetInfo = { id: 'V', kind: 'video', durationSec: 4, hasAudio: true };

  it('one input per visual clip with -ss in -t duration (video) / -loop 1 -framerate 30 -t duration (image)', () => {
    let doc = add(emptyTimeline('9:16'), photo, 0).doc;
    doc = add(doc, video, 5).doc;
    const c = compile(doc, [src('P', 'image'), src('V', 'video')]);
    const ins = inputs(c.args);
    expect(ins[0]).toEqual(['-loop', '1', '-framerate', '30', '-t', '5', '-i', '/w/P']);
    expect(ins[1]).toEqual(['-ss', '0', '-t', '4', '-i', '/w/V']);
  });

  it('overlay enable between(t,start,end) per clip in track order', () => {
    let doc = add(emptyTimeline('9:16'), photo, 1).doc;
    doc = { ...doc, tracks: [...doc.tracks, { id: 'top', kind: 'video', clips: [] }] };
    doc = addClip(doc, { id: 'Q', kind: 'image' }, { at: 0, trackId: 'top' }, ids).doc;
    const c = compile(doc, [src('P', 'image'), src('Q', 'image')]);
    const overlays = c.filterScript.match(/overlay=[^;\n]*/g)!;
    expect(overlays).toHaveLength(2);
    expect(overlays[0]).toContain("enable='between(t,1,6)'");
    expect(overlays[1]).toContain("enable='between(t,0,5)'");
    expect(overlays.every((o) => o.includes('eof_action=pass'))).toBe(true);
  });

  it('setpts shifts by start', () => {
    const doc = add(emptyTimeline('9:16'), photo, 2.5).doc;
    expect(compile(doc, [src('P', 'image')]).filterScript).toContain('setpts=PTS+2.5/TB');
  });

  it('tpad stop_mode=clone after video sources', () => {
    const doc = add(emptyTimeline('9:16'), video, 0).doc;
    expect(compile(doc, [src('V', 'video')]).filterScript).toMatch(
      /\[0:v\][^;]*tpad=stop_mode=clone:stop_duration=4[^;]*trim=duration=4/,
    );
  });

  it('fade alpha filters for fade and xfade', () => {
    let doc = add(emptyTimeline('9:16'), photo, 0).doc;
    doc = setEffect(doc, doc.tracks[0]!.clips[0]!.id, { type: 'fade', params: { in: 0.3, out: 1 } });
    const b = add(doc, { id: 'Q', kind: 'image' }, 5);
    doc = setTransition(b.doc, b.clipIds[0]!, 0.5);
    const g = compile(doc, [src('P', 'image'), src('Q', 'image')]).filterScript;
    expect(g).toContain('fade=t=in:st=0:d=0.3:alpha=1');
    expect(g).toContain('fade=t=out:st=4:d=1:alpha=1');
    expect(g).toContain('fade=t=in:st=0:d=0.5:alpha=1');
    expect(g).toContain('setpts=PTS+4.5/TB');
  });

  it('no zoompan anywhere', () => {
    const doc = add(emptyTimeline('9:16'), photo, 0).doc;
    const c = compile(doc, [src('P', 'image')]);
    expect([...c.args, c.filterScript].join(' ')).not.toContain('zoompan');
  });

  it('audio item → volume, afade, adelay=<ms>:all=1, amix normalize=0 with anullsrc of total duration', () => {
    let doc = add(emptyTimeline('9:16'), photo, 0).doc;
    const m = add(doc, { id: 'M', kind: 'audio', durationSec: 3 }, 1.5);
    doc = setVolume(m.doc, m.clipIds[0]!, 0.5);
    const c = compile(doc, [src('P', 'image'), src('M', 'audio')]);
    expect(inputs(c.args)[1]).toEqual(['-ss', '0', '-t', '3', '-i', '/w/M']);
    expect(c.filterScript).toMatch(/\[1:a\][^;]*volume=0\.5[^;]*adelay=1500:all=1/);
    expect(c.filterScript).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=5');
    expect(c.filterScript).toMatch(/amix=inputs=2:normalize=0:duration=first/);
  });

  it('mono audio goes to both channels at full level (as Web Audio plays it in the preview)', () => {
    const m = add(emptyTimeline('9:16'), { id: 'M', kind: 'audio', durationSec: 3 }, 0);
    expect(compile(m.doc, [src('M', 'audio', { audioChannels: 1 })]).filterScript).toMatch(
      /\[0:a\]pan=stereo\|c0=c0\|c1=c0,/,
    );
    expect(compile(m.doc, [src('M', 'audio', { audioChannels: 2 })]).filterScript).not.toContain('pan=');
  });

  it('audio fades are afade filters', () => {
    const m = add(emptyTimeline('9:16'), { id: 'M', kind: 'audio', durationSec: 3 }, 0);
    const doc = {
      ...m.doc,
      tracks: m.doc.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, fadeIn: 0.5, fadeOut: 1 })) })),
    } as TimelineDoc;
    const g = compile(doc, [src('M', 'audio')]).filterScript;
    expect(g).toContain('afade=t=in:st=0:d=0.5');
    expect(g).toContain('afade=t=out:st=2:d=1');
  });

  it('video clip with hasAudio false is not in amix even if volume > 0', () => {
    const v = add(emptyTimeline('9:16'), { id: 'S', kind: 'video', durationSec: 2, hasAudio: false }, 0);
    const c = compile(setVolume(v.doc, v.clipIds[0]!, 1), [src('S', 'video', { hasAudio: false })]);
    expect(inputs(c.args)).toHaveLength(1);
    expect(c.filterScript).not.toContain('amix');
    expect(c.filterScript).toMatch(/anullsrc=[^;]*\[aout\]/);
  });

  it('draft 9:16 → 720x1280 and -preset veryfast -crf 26', () => {
    const c = compile(add(emptyTimeline('9:16'), photo, 0).doc, [src('P', 'image')], 'draft');
    expect([c.width, c.height]).toEqual([720, 1280]);
    expect(c.args.join(' ')).toContain('-preset veryfast -crf 26');
    expect(c.filterScript).toContain('format=yuv420p[vout]');
    expect(outputSize(emptyTimeline('16:9'), 'draft')).toEqual({ width: 1280, height: 720 });
  });

  it('final → document size, -preset medium -crf 20', () => {
    const c = compile(add(emptyTimeline('16:9'), photo, 0).doc, [src('P', 'image')], 'final');
    expect([c.width, c.height]).toEqual([1920, 1080]);
    expect(c.args.join(' ')).toContain('-preset medium -crf 20');
    expect(c.args.join(' ')).toMatch(/-pix_fmt yuv420p -r 30 .*-c:a aac -b:a 192k -ar 48000/);
    expect(c.args).toContain('+faststart');
  });

  it('uses -filter_complex_script with filterScriptPath and maps outputs', () => {
    const c = compile(add(emptyTimeline('9:16'), photo, 0).doc, [src('P', 'image')]);
    expect(c.args.join(' ')).toContain('-filter_complex_script /w/graph.txt -map [vout] -map [aout]');
    expect(c.args.at(-1)).toBe('/w/out.mp4');
    expect(c.args.join(' ')).toContain('-progress pipe:1');
  });

  it('-t equals docDuration', () => {
    let doc = add(emptyTimeline('9:16'), photo, 0).doc;
    doc = add(doc, { id: 'M', kind: 'audio', durationSec: 7.5 }, 1).doc;
    const c = compile(doc, [src('P', 'image'), src('M', 'audio')]);
    expect(c.durationSec).toBe(8.5);
    expect(c.args[c.args.indexOf('-t', c.args.indexOf('-filter_complex_script')) + 1]).toBe('8.5');
  });

  it('ken burns composes at 2x and downsamples to the output size (smooth sub-pixel motion)', () => {
    const c = compile(add(emptyTimeline('9:16'), photo, 0).doc, [src('P', 'image')], 'draft');
    expect(c.filterScript).toContain('color=c=black:s=1440x2560:r=30');
    expect(c.filterScript).toMatch(/scale=720:1280:flags=area,format=yuv420p\[vout\]/);
    expect([c.width, c.height]).toEqual([720, 1280]);
  });

  it('without ken burns composes at 1x', () => {
    const c = compile(add(emptyTimeline('9:16'), video, 0).doc, [src('V', 'video')], 'draft');
    expect(c.filterScript).toContain('color=c=black:s=720x1280:r=30');
    expect(c.filterScript).not.toContain('flags=area');
  });

  it('missing source → VALIDATION with clip ids', () => {
    const r = add(emptyTimeline('9:16'), photo, 0);
    expect(() => compile(r.doc, [])).toThrow(
      expect.objectContaining({ code: 'VALIDATION', details: { clipIds: r.clipIds } }),
    );
  });

  it('200 clips compile and args stay under 32 KB (graph is in the file)', () => {
    let doc = emptyTimeline('9:16');
    const sources: [string, SourceInfo][] = [];
    for (let i = 0; i < 200; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      doc = add(doc, { id, kind: 'image' }, i * 5).doc;
      sources.push([
        id,
        { path: `/tmp/vf-render-abcdef/${id}.png`, kind: 'image', width: 1200, height: 800, hasAudio: false },
      ]);
    }
    const c = compile(doc, sources);
    expect(c.args.join(' ').length).toBeLessThan(32 * 1024);
    expect(c.filterScript.match(/overlay=/g)).toHaveLength(200);
  });
});

describe('transformFilter', () => {
  const out = { width: 720, height: 1280 };
  const cases = [
    {
      name: 'cover kenburns',
      fit: 'cover' as const,
      srcSize: { width: 1200, height: 1200 },
      kb: { fromScale: 1, toScale: 1.4, fromX: 0.2, fromY: 0.8, toX: 0.6, toY: 0.3 },
    },
    {
      name: 'contain zoom',
      fit: 'contain' as const,
      srcSize: { width: 1920, height: 1080 },
      kb: { fromScale: 0.8, toScale: 0.8, fromX: 0.3, fromY: 0.5, toX: 0.3, toY: 0.5 },
    },
  ];
  for (const c of cases)
    it(`${c.name}: scale/x/y expressions equal coverRect`, () => {
      const effects = [{ type: 'kenburns' as const, params: c.kb }];
      const tf = transformFilter(effects, c.srcSize, out, c.fit, 5, 2);
      for (const p of [0, 0.25, 0.5, 1]) {
        const local = p * 5;
        const s = c.kb.fromScale + (c.kb.toScale - c.kb.fromScale) * p;
        const r = coverRect(
          c.srcSize,
          out,
          c.fit,
          s,
          c.kb.fromX + (c.kb.toX - c.kb.fromX) * p,
          c.kb.fromY + (c.kb.toY - c.kb.fromY) * p,
        );
        const w = evalExpr(tf.w, { t: local });
        const h = evalExpr(tf.h, { t: local });
        expect(w).toBeCloseTo(r.w, 6);
        expect(h).toBeCloseTo(r.h, 6);
        // у оверлеї — глобальний час і фактичний (округлений) розмір кадру
        expect(evalExpr(tf.x, { t: local + 2, overlay_w: w, overlay_h: h })).toBeCloseTo(r.x, 6);
        expect(evalExpr(tf.y, { t: local + 2, overlay_w: w, overlay_h: h })).toBeCloseTo(r.y, 6);
      }
    });
});
