import type { SourceLengths } from '@vf/timeline';
import { isPresent, type AnyAsset } from './types';

/** Тривалості джерел для меж тріму: відео/аудіо — з метаданих, фото — без меж. */
export function sourceLengths(assets: Record<string, AnyAsset>): SourceLengths {
  const out: SourceLengths = {};
  for (const [id, a] of Object.entries(assets))
    if (isPresent(a) && a.kind !== 'image' && a.durationMs) out[id] = a.durationMs / 1000;
  return out;
}
