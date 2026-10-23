import type { TimelineDoc } from '@vf/shared';
import { syncVoiceTrack, voiceTrackOf, type VoiceTake } from '@vf/timeline';
import { isReadOnlyState, type EditorStore } from './store';

/** Що потрібно синхронізації з `voice.get`: базова мова й її готові незастарілі дублі. */
export interface VoiceSyncView {
  base: string;
  baseTakes: VoiceTake[];
}

/** Стабільний ключ набору дублів: `segmentId:assetId` у порядку сегментів (так їх віддає сервер). */
export const takesKey = (takes: VoiceTake[]): string => takes.map((t) => `${t.segmentId}:${t.assetId}`).join('|');

/**
 * Синхронізація доріжки озвучки базової мови в редакторі (спека §3.2, виклик 2): звичайна операція стору
 * (крок історії, автозбереження). Лише в «Монтажі», не заморожено/не заблоковано. Той самий набір дублів
 * застосовується один раз: undo синхронізації не відкочується назад наступним оновленням тих самих даних.
 * Пропущений (режим, заморожено) набір не запам'ятовується — застосується при наступному виклику.
 */
export function createVoiceSync() {
  let lastKey: string | null = null;
  return {
    run(store: EditorStore, view: VoiceSyncView | undefined) {
      if (!view) return;
      const s = store.getState();
      if (s.mode.kind !== 'edit' || s.locked || isReadOnlyState(s)) return;
      const key = `${view.base}#${takesKey(view.baseTakes)}`;
      if (key === lastKey) return;
      lastKey = key;
      s.apply((d) => syncVoiceTrack(d, { language: view.base, takes: view.baseTakes }).doc);
    },
  };
}

/** Кліпи озвучки мови, що виходять за кінець свого сегмента: `clipId → на скільки секунд` (менше пів кадру — ні). */
export function voiceOverflow(doc: TimelineDoc, language: string): Map<string, number> {
  const out = new Map<string, number>();
  const track = voiceTrackOf(doc, language);
  if (!track) return out;
  const ends = new Map((doc.segments ?? []).map((s) => [s.id, s.end]));
  const eps = 0.5 / doc.fps;
  for (const c of track.clips) {
    const end = c.sceneId !== undefined ? ends.get(c.sceneId) : undefined;
    if (end === undefined) continue;
    const over = c.start + c.duration - end;
    if (over > eps) out.set(c.id, over);
  }
  return out;
}

/** «Озвучка довша за сцену на 1,2 с» (округлення вгору до десятої). */
export const overflowHint = (sec: number): string =>
  `Озвучка довша за сцену на ${(Math.ceil(sec * 10 - 1e-9) / 10).toFixed(1).replace('.', ',')} с`;
