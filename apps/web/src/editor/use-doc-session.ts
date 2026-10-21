import type { ProjectView } from '@vf/api';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { trpcClient } from '@/lib/trpc';
import { Autosave, type SaveState } from './autosave';
import { canReplaceDoc } from './reload-guard';
import { createEditorStore } from './store';

/**
 * Документ проєкту без решти редактора (файли, прев'ю): стор з історією zundo + автозбереження `projects.save`.
 * Для студії озвучки; `onSaved` — після кожного збереження (сегменти на сервері змінились).
 */
export function useDocSession(project: ProjectView, onSaved?: () => void) {
  const [store] = useState(() => createEditorStore(project.timeline));
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saved] = useState<{ current: (() => void) | undefined }>(() => ({ current: undefined }));
  saved.current = onSaved;
  const [autosave] = useState(
    () =>
      new Autosave({
        save: (timeline, baseVersion) => trpcClient.projects.save.mutate({ id: project.id, timeline, baseVersion }),
        debounceMs: 1500,
        version: project.version,
        onState: (s) => {
          setSaveState(s);
          if (s === 'saved') saved.current?.();
        },
      }),
  );

  const doc = useStore(store, (s) => s.doc);

  useEffect(() => {
    let prev = store.getState().doc;
    return store.subscribe((s) => {
      if (s.doc === prev) return;
      prev = s.doc;
      autosave.change(s.doc);
    });
  }, [store, autosave]);

  // вихід зі сторінки
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void autosave.flush();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (autosave.hasPending()) {
        void autosave.flush();
        e.preventDefault();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onUnload);
      void autosave.flush();
    };
  }, [autosave]);

  /**
   * Серверна версія замість локальної. `onlyIfClean` (після задачі на сервері): якщо користувач щось змінив
   * до або під час запиту — нічого не замінюємо (повертає `false`).
   */
  const reload = useCallback(
    async (opts: { onlyIfClean?: boolean } = {}): Promise<boolean> => {
      const before = store.getState().doc;
      if (opts.onlyIfClean && autosave.hasPending()) return false;
      const fresh = await trpcClient.projects.get.query({ id: project.id });
      if (opts.onlyIfClean && !canReplaceDoc(before, store.getState().doc, autosave.hasPending())) return false;
      store.getState().replaceDoc(fresh.timeline);
      autosave.reset(fresh.version);
      return true;
    },
    [project.id, store, autosave],
  );

  /** «Перезаписати моєю версією»: зберегти поверх актуальної версії. */
  const overwrite = useCallback(async () => {
    const fresh = await trpcClient.projects.get.query({ id: project.id });
    autosave.setVersion(fresh.version);
    autosave.change(store.getState().doc);
    await autosave.flush();
  }, [project.id, autosave, store]);

  return { store, doc, autosave, saveState, reload, overwrite };
}
