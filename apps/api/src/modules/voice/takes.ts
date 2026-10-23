import type { voiceLines } from '@vf/db';
import type { Segment, VoiceChoice } from '@vf/shared';
import type { VoiceTake } from '@vf/timeline';
import { lineState } from './stale';

type VoiceLineRow = typeof voiceLines.$inferSelect;

/**
 * Готові дублі мови в порядку сегментів і сегменти, чия озвучка не готова (не озвучено, застаріла,
 * помилка, у роботі) або з базовим текстом без перекладу. `rows` можуть містити рядки інших мов —
 * беруться лише рядки `language`.
 */
export function collectTakes(
  rows: VoiceLineRow[],
  segments: Segment[],
  opts: { language: string; isBase: boolean; baseText: Map<string, string>; voice: VoiceChoice | null },
): { takes: VoiceTake[]; notReady: string[] } {
  const { language, isBase, baseText, voice } = opts;
  const own = new Map(rows.filter((r) => r.language === language).map((r) => [r.segmentId, r]));
  const takes: VoiceTake[] = [];
  const notReady: string[] = [];
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
    else notReady.push(s.id);
  }
  return { takes, notReady };
}
