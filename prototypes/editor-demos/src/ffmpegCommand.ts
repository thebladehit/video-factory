import { Project, projectDuration } from './model';

// Демо A: сервер отримує JSON проєкту і будує одну команду FFmpeg з filter_complex.
// Підхід "полотно + накладання": чорне полотно на всю тривалість, кожен кліп
// масштабується/обрізається до кадру, зсувається в часі (setpts) і накладається (overlay)
// у своєму інтервалі. Так однаково обробляються прогалини, перекриття та кілька доріжок.

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\u2019").replace(/:/g, '\\:').replace(/%/g, '\\%');
const n = (x: number) => +x.toFixed(3);

export function buildFfmpegCommand(p: Project): string {
  const W = p.width, H = p.height, fps = p.fps;
  const total = n(projectDuration(p));
  const inputs: string[] = [];
  const filters: string[] = [`color=c=black:s=${W}x${H}:r=${fps}:d=${total}[base]`];
  let last = 'base';
  let idx = 0;

  const media = p.clips.filter((c) => c.track === 'media').sort((a, b) => a.start - b.start);
  for (const c of media) {
    const a = p.assets.find((x) => x.id === c.assetId);
    if (!a) continue;
    const file = `assets/${a.name}`;
    const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
    if (a.kind === 'image') {
      inputs.push(`-loop 1 -framerate ${fps} -t ${n(c.duration)} -i "${file}"`);
      const frames = Math.round(c.duration * fps);
      // Ken Burns: zoompan з тим самим законом зуму, що і в прев'ю (1 → 1.08)
      filters.push(`[${idx}:v]${cover},zoompan=z='1+0.08*on/${frames}':d=1:x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':s=${W}x${H}:fps=${fps},fade=in:st=0:d=0.3,setpts=PTS-STARTPTS+${n(c.start)}/TB[v${idx}]`);
    } else {
      inputs.push(`-ss ${n(c.in)} -t ${n(c.duration)} -i "${file}"`);
      filters.push(`[${idx}:v]${cover},fps=${fps},fade=in:st=0:d=0.3,setpts=PTS-STARTPTS+${n(c.start)}/TB[v${idx}]`);
    }
    filters.push(`[${last}][v${idx}]overlay=eof_action=pass:enable='between(t,${n(c.start)},${n(c.start + c.duration)})'[o${idx}]`);
    last = `o${idx}`;
    idx++;
  }

  const texts = p.clips.filter((c) => c.track === 'text');
  if (texts.length) {
    const fs = Math.round(Math.min(W, H) * 0.075);
    const dt = texts.map((c) =>
      `drawtext=fontfile=fonts/Inter-Black.ttf:text='${esc((c.text ?? '').toUpperCase())}':fontsize=${fs}:fontcolor=white:borderw=${Math.round(fs * 0.09)}:bordercolor=black:x=(w-text_w)/2:y=h*0.74-text_h/2:enable='between(t,${n(c.start)},${n(c.start + c.duration)})'`
    ).join(',\n    ');
    filters.push(`[${last}]${dt}[out]`);
    last = 'out';
  }

  return [
    'ffmpeg -y \\',
    ...inputs.map((i) => `  ${i} \\`),
    `  -filter_complex "\n    ${filters.join(';\n    ')}" \\`,
    `  -map "[${last}]" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \\`,
    `  -r ${fps} -t ${total} -movflags +faststart out.mp4`,
  ].join('\n');
}
