import { writeFile } from 'node:fs/promises';
import { run, type MediaTools } from '@vf/media';
import { compileFfmpeg } from './compile';
import { parseProgress } from './progress';
import type { CompileInput } from './types';

export interface RenderContext {
  signal: AbortSignal;
  /** 0..95: останні відсотки — завантаження й обробка результату */
  onProgress(pct: number): void;
  timeoutMs: number;
}

export interface Renderer {
  render(input: CompileInput, ctx: RenderContext): Promise<void>;
}

export function createFfmpegRenderer(tools: MediaTools): Renderer {
  return {
    async render(input, ctx) {
      const compiled = compileFfmpeg(input);
      await writeFile(input.filterScriptPath, compiled.filterScript);
      let pending = '';
      let last = -1;
      await run(tools.ffmpegPath, compiled.args, {
        signal: ctx.signal,
        timeoutMs: ctx.timeoutMs,
        onStdout(chunk) {
          // рядки можуть розірватися між фрагментами
          const text = pending + chunk.toString();
          const cut = text.lastIndexOf('\n');
          pending = text.slice(cut + 1);
          const pct = parseProgress(text.slice(0, cut + 1), compiled.durationSec);
          if (pct === null) return;
          const capped = Math.min(95, Math.floor(pct));
          if (capped > last) {
            last = capped;
            ctx.onProgress(capped);
          }
        },
      });
      if (last < 95) ctx.onProgress(95);
    },
  };
}
