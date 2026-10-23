import type { TimelineDoc } from '@vf/shared';
import { syncVoiceTrack, voiceTrackOf, type VoiceTake } from '@vf/timeline';
import { isReadOnlyState, type EditorStore } from './store';

/**
 * Що потрібно синхронізації з `voice.get`: базова мова, її готові незастарілі дублі й сегменти з дублем
 * у роботі/застарілим (`basePending` — їхні кліпи не чіпаються).
 */
export interface VoiceSyncView {
  base: string;
  baseTakes: VoiceTake[];
  basePending: string[];
}

/** Стабільний ключ набору дублів: `segmentId:assetId` у порядку сегментів (так їх віддає сервер). */
export const takesKey = (takes: VoiceTake[]): string => takes.map((t) => `${t.segmentId}:${t.assetId}`).join('|');

/**
 * Синхронізація доріжки озвучки базової мови в редакторі (спека §3.2, виклик 2): звичайна операція стору
 * (крок історії, автозбереження). Лише в «Монтажі», не заморожено/не заблоковано. Той самий набір дублів
 * застосовується один раз: undo синхронізації не відкочується назад наступним оновленням тих самих даних.
 * Пропущений (режим, заморожено, відкритий жест) набір не запам'ятовується — застосується при наступному виклику.
 */
export function createVoiceSync() {
  let lastKey: string | null = null;
  return {
    run(store: EditorStore, view: VoiceSyncView | undefined) {
      if (!view) return;
      const s = store.getState();
      // відкритий жест перебудовує документ зі стану до жесту — синхронізація загубилась би; повтор — після жесту
      if (s.mode.kind !== 'edit' || s.locked || s.gesturing || isReadOnlyState(s)) return;
      // pending — частина ключа: перехід pending → ready/очищено синхронізується знову
      const key = `${view.base}#${takesKey(view.baseTakes)}#${view.basePending.join('|')}`;
      if (key === lastKey) return;
      lastKey = key;
      s.apply((d) => syncVoiceTrack(d, { language: view.base, takes: view.baseTakes, pending: view.basePending }).doc);
    },
    /** Документ замінено серверним (перезавантаження після конфлікту): той самий набір дублів застосовується знову */
    reset() {
      lastKey = null;
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
