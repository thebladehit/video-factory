import type { Autosave } from './autosave';
import type { EditorMode, EditorStore } from './store';

/**
 * Зміни документа стору → автозбереження того режиму, в якому їх зробив користувач.
 * Перемикання режиму (заміна документа цілком) — не зміна користувача: нічого не зберігається,
 * тож базовий документ ніколи не потрапить у мовну копію і навпаки. Режим без автозбереження (перегляд) — `null`.
 */
export function bindAutosave(store: EditorStore, autosaveFor: (mode: EditorMode) => Autosave | null): () => void {
  let prevDoc = store.getState().doc;
  let prevMode = store.getState().mode;
  return store.subscribe((s) => {
    if (s.mode !== prevMode) {
      prevMode = s.mode;
      prevDoc = s.doc;
      return;
    }
    if (s.doc === prevDoc) return;
    prevDoc = s.doc;
    autosaveFor(s.mode)?.change(s.doc);
  });
}
