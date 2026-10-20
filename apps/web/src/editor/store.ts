import { temporal } from 'zundo';
import { createStore } from 'zustand/vanilla';
import type { TimelineDoc } from '@vf/shared';

export interface EditorState {
  doc: TimelineDoc;
  /** Чиста операція над документом; без змін — без кроку історії */
  apply(op: (d: TimelineDoc) => TimelineDoc): void;
  /** Жест (рух, трім, повзунок) — один крок історії: проміжні оновлення не записуються */
  beginGesture(): void;
  endGesture(): void;
  /** Документ з сервера (перезавантаження після конфлікту) — історія очищується */
  replaceDoc(doc: TimelineDoc): void;
}

export const HISTORY_LIMIT = 100;

export function createEditorStore(initial: TimelineDoc) {
  let gestureStart: TimelineDoc | null = null;
  const store = createStore<EditorState>()(
    temporal(
      (set, get) => ({
        doc: initial,
        apply(op) {
          const next = op(get().doc);
          if (next !== get().doc) set({ doc: next });
        },
        beginGesture() {
          if (gestureStart) return;
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
