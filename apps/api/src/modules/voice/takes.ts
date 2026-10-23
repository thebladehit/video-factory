import { and, eq } from 'drizzle-orm';
import { voiceLines } from '@vf/db';
import { normalizeDoc, type Segment, type VoiceChoice } from '@vf/shared';
import type { VoiceTake } from '@vf/timeline';
import type { AppDeps } from '../../app';
import type { ProjectRow } from '../projects/service';
import { lineState } from './stale';
import { voiceForLanguage } from './choice';

type VoiceLineRow = typeof voiceLines.$inferSelect;

/** Готові дублі й сегменти з дублем у роботі/застарілим (`syncVoiceTrack` `takes`/`pending`). */
export interface VoiceTakes {
  takes: VoiceTake[];
  pending: string[];
}

/**
 * Готові дублі мови в порядку сегментів і сегменти, чия озвучка не готова (не озвучено, застаріла,
 * помилка, у роботі) або з базовим текстом без перекладу. `pending` — ті з неготових, у чийого рядка є
 * текст і попередній дубль (переозвучка, застарів, помилка): синхронізація доріжки озвучки не чіпає їхніх кліпів.
 * `rows` можуть містити рядки інших мов — беруться лише рядки `language`.
 */
export function collectTakes(
  rows: VoiceLineRow[],
  segments: Segment[],
  opts: { language: string; isBase: boolean; baseText: Map<string, string>; voice: VoiceChoice | null },
): VoiceTakes & { notReady: string[] } {
  const { language, isBase, baseText, voice } = opts;
  const own = new Map(rows.filter((r) => r.language === language).map((r) => [r.segmentId, r]));
  const takes: VoiceTake[] = [];
  const notReady: string[] = [];
  const pending: string[] = [];
  for (const s of segments) {
    const r = own.get(s.id);
    if (!r?.text.trim()) {
      // базовий текст є, а перекладу немає — сегмент не готовий (інакше мова вийшла б без голосу)
      if (!isBase && baseText.get(s.id)?.trim()) notReady.push(s.id);
      continue;
    }
    const state = lineState(r, isBase ? undefined : baseText.get(s.id), voice);
    if (state === 'ready' && r.audioAssetId && r.durationMs !== null)
      takes.push({
        segmentId: s.id,
        assetId: r.audioAssetId,
        durationSec: r.durationMs / 1000,
        transcriptId: r.transcriptId ?? '',
      });
    else {
      notReady.push(s.id);
      if (r.audioAssetId) pending.push(s.id);
    }
  }
  return { takes, pending, notReady };
}

/**
 * Готові дублі базової мови й сегменти з дублем у роботі; сегменти визначає `p.timeline`. `voice` (якщо задано) замінює пошук голосу
 * проєкту/користувача.
 */
export async function baseTakesOf(
  deps: AppDeps,
  userId: string,
  p: ProjectRow,
  voice?: VoiceChoice | null,
): Promise<VoiceTakes> {
  const rows = await deps.db
    .select()
    .from(voiceLines)
    .where(and(eq(voiceLines.projectId, p.id), eq(voiceLines.language, p.baseLanguage)));
  const baseText = new Map(rows.map((r) => [r.segmentId, r.text]));
  const { takes, pending } = collectTakes(rows, normalizeDoc(p.timeline).segments ?? [], {
    language: p.baseLanguage,
    isBase: true,
    baseText,
    voice: voice !== undefined ? voice : await voiceForLanguage(deps, userId, p, p.baseLanguage),
  });
  return { takes, pending };
}
