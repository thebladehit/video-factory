import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthVideo, type MediaTools } from '@vf/media';
import type { Aspect, VideoGen } from '../types';

const SIZES: Record<Aspect, [number, number]> = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [768, 768] };
const RUNNING_POLLS = 2;

/** Fake-відео: двічі «running», потім кольоровий mp4 (колір — з хешу промпту). Без витрат. */
export function createFakeVideo(tools: MediaTools): VideoGen {
  const polls = new Map<string, number>();
  return {
    async start({ prompt, aspect, durationSec }) {
      const id = randomUUID();
      polls.set(id, 0);
      return { provider: 'fake', data: { id, prompt, aspect, durationSec: durationSec ?? 2 } };
    },
    async poll(ref) {
      const { id, prompt, aspect, durationSec } = ref.data as {
        id: string;
        prompt: string;
        aspect: Aspect;
        durationSec: number;
      };
      // після рестарту лічильника немає — одразу віддаємо результат
      const n = polls.get(id) ?? RUNNING_POLLS;
      if (n < RUNNING_POLLS) {
        polls.set(id, n + 1);
        return { state: 'running', progress: ((n + 1) / (RUNNING_POLLS + 1)) * 100 };
      }
      polls.delete(id);
      const [width, height] = SIZES[aspect];
      const color = `#${createHash('sha1').update(prompt).digest('hex').slice(0, 6)}`;
      const dir = await mkdtemp(join(tmpdir(), 'vf-fake-video-'));
      try {
        const out = join(dir, 'v.mp4');
        await synthVideo(tools, out, { width, height, durationSec, color });
        return [
          {
            bytes: new Uint8Array(await readFile(out)),
            mime: 'video/mp4',
            width,
            height,
            durationMs: durationSec * 1000,
          },
        ];
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
