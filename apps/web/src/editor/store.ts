import { temporal } from 'zundo';
import { createStore } from 'zustand/vanilla';
import type { TimelineDoc } from '@vf/shared';

/**
 * Що зараз у сторі: `edit` — базовий документ («Монтаж»); `language` — документ мови.
 * Не відокремлена мова — лише перегляд `voice.localized` (зміни ігноруються); відокремлена — власний документ.
 */
export type EditorMode = { kind: 'edit' } | { kind: 'language'; language: string; separated: boolean };

export const isReadOnlyMode = (m: EditorMode): boolean => m.kind === 'language' && !m.separated;

export interface EditorState {
  doc: TimelineDoc;
  /** Режим — поза історією zundo (`partialize`) */
  mode: EditorMode;
  /** Тимчасово лише для читання (перемикання режиму, відокремлення): зміни ігноруються, жест завершується */
  locked: boolean;
  setLocked(locked: boolean): void;
  /** Інший документ цілком (режим + документ атомарно); історія очищується, зберігання не запускається */
  switchMode(mode: EditorMode, doc: TimelineDoc): void;
  /** Чиста операція над документом; без змін — без кроку історії */
  apply(op: (d: TimelineDoc) => TimelineDoc): void;
  /** Жест (рух, трім, повзунок) — один крок історії: проміжні оновлення не записуються */
  beginGesture(): void;
  endGesture(): void;
  /** Документ з сервера (перезавантаження після конфлікту) — історія очищується */
  replaceDoc(doc: TimelineDoc): void;
  /** Файл з ОС отримав id у бібліотеці: `local:…` → uuid у документі й у всій історії (не крок історії) */
  rewriteAssetId(from: string, to: string): void;
}

function renameAsset(doc: TimelineDoc, from: string, to: string): TimelineDoc {
  let changed = false;
  const tracks = doc.tracks.map((t) => {
    if (t.kind === 'captions' || !t.clips.some((c) => c.assetId === from)) return t;
    changed = true;
    return { ...t, clips: t.clips.map((c) => (c.assetId === from ? { ...c, assetId: to } : c)) } as typeof t;
  });
  return changed ? { ...doc, tracks } : doc;
}

export const HISTORY_LIMIT = 100;

export function createEditorStore(initial: TimelineDoc) {
  let gestureStart: TimelineDoc | null = null;
  const store = createStore<EditorState>()(
    temporal(
      (set, get) => ({
        doc: initial,
        mode: { kind: 'edit' },
        locked: false,
        setLocked(locked) {
          if (locked) get().endGesture();
          // не крок історії
          store.temporal.getState().pause();
          set({ locked });
          store.temporal.getState().resume();
        },
        switchMode(mode, doc) {
          gestureStart = null;
          store.temporal.getState().pause();
          set({ mode, doc });
          store.temporal.getState().resume();
          store.temporal.getState().clear();
        },
        apply(op) {
          if (get().locked || isReadOnlyMode(get().mode)) return;
          const next = op(get().doc);
          if (next !== get().doc) set({ doc: next });
        },
        beginGesture() {
          if (gestureStart || get().locked || isReadOnlyMode(get().mode)) return;
          gestureStart = get().doc;
          store.temporal.getState().pause();
        },
        endGesture() {
          const start = gestureStart;
          if (!start) return;
          gestureStart = null;
          const final = get().doc;
          // історія бачить один перехід: стан до жесту → стан після
          set({ doc: start });
          store.temporal.getState().resume();
          if (final !== start) set({ doc: final });
        },
        rewriteAssetId(from, to) {
          const t = store.temporal;
          const map = (states: Partial<{ doc: TimelineDoc }>[]) =>
            states.map((st) => (st.doc ? { ...st, doc: renameAsset(st.doc, from, to) } : st));
          t.getState().pause();
          set({ doc: renameAsset(get().doc, from, to) });
          t.getState().resume();
          t.setState({ pastStates: map(t.getState().pastStates), futureStates: map(t.getState().futureStates) });
        },
        replaceDoc(doc) {
          gestureStart = null;
          store.temporal.getState().pause();
          set({ doc });
          store.temporal.getState().resume();
          store.temporal.getState().clear();
        },
      }),
      { limit: HISTORY_LIMIT, partialize: (s) => ({ doc: s.doc }) },
    ),
  );
  return store;
}

export type EditorStore = ReturnType<typeof createEditorStore>;

export interface UiState {
  selected: string[];
  playhead: number;
  pxPerSec: number;
  playing: boolean;
  /** Лінія-підказка снепінгу (секунди) */
  snapLine: number | null;
  /** Кліпи, які сервер не пустив у рендер (видалені/необроблені файли) */
  invalidClips: string[];
  set(patch: Partial<Omit<UiState, 'set'>>): void;
}

export function createUiStore() {
  return createStore<UiState>()((set) => ({
    selected: [],
    playhead: 0,
    pxPerSec: 60,
    playing: false,
    snapLine: null,
    invalidClips: [],
    set: (patch) => set(patch),
  }));
}

export type UiStore = ReturnType<typeof createUiStore>;
