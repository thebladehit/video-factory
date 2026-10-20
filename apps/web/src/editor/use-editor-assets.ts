import { useQueryClient } from '@tanstack/react-query';
import type { EditorAsset, ProjectView } from '@vf/api';
import { kindForMime, TERMINAL_STATUSES, type TimelineDoc } from '@vf/shared';
import { addClip, addLinkedAudio, allClips, deleteClips, findClip, type AssetInfo } from '@vf/timeline';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from 'zustand';
import { useUploads } from '@/components/upload/UploadProvider';
import { useJobFeed } from '@/lib/job-feed';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { Autosave, type SaveState } from './autosave';
import { reconcileUploads, type TrackedUpload } from './uploads';
import { createCanvasPreviewEngine } from './preview-engine';
import { createEditorStore, createUiStore } from './store';
import { isPresent, type AnyAsset, type LocalAsset } from './types';

const REFRESH_BEFORE_MS = 5 * 60_000;
export const PHOTO_SECONDS = 5;

const assetIdsOf = (doc: TimelineDoc) => [...new Set(allClips(doc).map((c) => c.assetId))];

export const assetInfo = (a: AnyAsset): AssetInfo | null =>
  isPresent(a)
    ? { id: a.id, kind: a.kind, durationSec: a.durationMs ? a.durationMs / 1000 : undefined, hasAudio: a.hasAudio }
    : null;

/** Метадані файлу з ОС, прочитані браузером (тривалість — loadedmetadata; фото — 5 с). */
function readLocal(file: File, url: string, kind: 'image' | 'video' | 'audio') {
  return new Promise<{ durationMs: number | null; width: number | null; height: number | null }>((resolve) => {
    if (kind === 'image') {
      const img = new Image();
      img.onload = () => resolve({ durationMs: null, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ durationMs: null, width: null, height: null });
      img.src = url;
      return;
    }
    const el = document.createElement(kind);
    el.preload = 'metadata';
    el.onloadedmetadata = () =>
      resolve({
        durationMs: Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null,
        width: el instanceof HTMLVideoElement ? el.videoWidth : null,
        height: el instanceof HTMLVideoElement ? el.videoHeight : null,
      });
    el.onerror = () => resolve({ durationMs: null, width: null, height: null });
    el.src = url;
  });
}

/**
 * Сесія редактора: документ (стор + історія), UI-стан, прев'ю, файли (URL з оновленням), автозбереження,
 * файли з ОС (локальний кліп → asset бібліотеки → серверний URL і зв'язаний звук).
 */
export function useEditorSession(project: ProjectView) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const uploads = useUploads();
  const [store] = useState(() => createEditorStore(project.timeline));
  const [ui] = useState(createUiStore);
  const [engine] = useState(createCanvasPreviewEngine);
  const [assets, setAssets] = useState<Record<string, AnyAsset>>(project.assets);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  /** uploadId → local:id */
  const localUploads = useRef(new Map<string, string>());
  /** Файли з ОС, що вже мають id у бібліотеці, але ще обробляються (лишаються з blob:-URL) */
  const awaiting = useRef(new Set<string>());

  const merge = useCallback((patch: Record<string, AnyAsset>) => setAssets((a) => ({ ...a, ...patch })), []);
  const fetchAssets = useCallback(
    async (ids: string[]) => {
      const real = ids.filter((id) => !id.startsWith('local:'));
      if (!real.length) return {};
      const got = await trpcClient.projects.assets.query({ ids: real });
      merge(got);
      return got;
    },
    [merge],
  );

  const [autosave] = useState(
    () =>
      new Autosave({
        save: (timeline, baseVersion) => trpcClient.projects.save.mutate({ id: project.id, timeline, baseVersion }),
        debounceMs: 1500,
        version: project.version,
        onState: setSaveState,
      }),
  );

  // документ → автозбереження і прев'ю
  useEffect(() => {
    let prev = store.getState().doc;
    return store.subscribe((s) => {
      if (s.doc === prev) return;
      prev = s.doc;
      autosave.change(s.doc);
      // файл з бібліотеки, якого ще немає в мапі
      const unknown = assetIdsOf(s.doc).filter((id) => !(id in assetsRef.current) && !awaiting.current.has(id));
      if (unknown.length) void fetchAssets(unknown);
    });
  }, [store, autosave, fetchAssets]);

  const doc = useStore(store, (s) => s.doc);
  useEffect(() => engine.setDoc(doc, assets), [engine, doc, assets]);

  useEffect(() => {
    const offs = [
      engine.onTime((t) => ui.getState().set({ playhead: t })),
      engine.onEnded(() => ui.getState().set({ playing: false })),
      engine.onRefresh((id) => void fetchAssets([id])),
    ];
    return () => {
      offs.forEach((off) => off());
      engine.destroy();
    };
  }, [engine, ui, fetchAssets]);

  // підписані URL — оновити за 5 хв до закінчення
  useEffect(() => {
    const expiries = Object.values(assets)
      .filter((a): a is EditorAsset & { missing: false } => isPresent(a) && !('local' in a))
      .map((a) => Date.parse(a.urlExpiresAt));
    if (!expiries.length) return;
    const wait = Math.max(5_000, Math.min(...expiries) - Date.now() - REFRESH_BEFORE_MS);
    const timer = setTimeout(() => void fetchAssets(Object.keys(assetsRef.current)), wait);
    return () => clearTimeout(timer);
  }, [assets, fetchAssets]);

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

  // файли з ОС: прогрес, id у бібліотеці, помилки й скасування
  useEffect(() => {
    const tracked = new Map<string, TrackedUpload>();
    for (const [uploadId, id] of localUploads.current) {
      const a = assetsRef.current[id];
      tracked.set(uploadId, { id, local: isPresent(a) && 'local' in a });
    }
    for (const action of reconcileUploads(uploads.items, tracked)) {
      if (action.type === 'forget') localUploads.current.delete(action.uploadId);
      else if (action.type === 'rewrite') {
        const { from, to } = action;
        const cur = assetsRef.current[from];
        localUploads.current.set(action.uploadId, to);
        awaiting.current.add(to);
        store.getState().rewriteAssetId(from, to);
        const next = { ...assetsRef.current };
        delete next[from];
        if (isPresent(cur)) next[to] = { ...cur, id: to } as LocalAsset;
        assetsRef.current = next;
        setAssets(next);
      } else if (action.type === 'progress') {
        const cur = assetsRef.current[action.id];
        if (isPresent(cur) && 'local' in cur && Math.round(cur.progress) !== Math.round(action.progress))
          merge({ [action.id]: { ...cur, progress: action.progress } });
      } else {
        // файлу не буде: кліпи прибираємо; в історії id стає «відсутнім» (undo покаже заглушку, а не вічний local:)
        localUploads.current.delete(action.uploadId);
        awaiting.current.delete(action.id);
        const gone = `missing:${action.uploadId}`;
        store.getState().rewriteAssetId(action.id, gone);
        const next = { ...assetsRef.current, [gone]: { id: gone, missing: true } as AnyAsset };
        delete next[action.id];
        assetsRef.current = next;
        setAssets(next);
        const ids = allClips(store.getState().doc)
          .filter((c) => c.assetId === gone)
          .map((c) => c.id);
        store.getState().apply((d) => deleteClips(d, ids));
        toast.error(action.message);
      }
    }
  }, [uploads.items, store, merge]);

  // файл оброблено → серверний URL; відео зі звуком отримує зв'язаний аудіокліп
  useJobFeed((e) => {
    if (e.type !== 'asset.process' || !e.subject.assetId || !TERMINAL_STATUSES.has(e.status)) return;
    const id = e.subject.assetId;
    if (!awaiting.current.delete(id)) return;
    void fetchAssets([id]).then((got) => {
      const a = got[id];
      if (!a || a.missing || a.kind !== 'video' || !a.hasAudio) return;
      const clips = store
        .getState()
        .doc.tracks.flatMap((t) => (t.kind === 'video' ? t.clips.filter((c) => c.assetId === id && !c.linkId) : []));
      for (const c of clips) store.getState().apply((d) => addLinkedAudio(d, c.id));
    });
  });

  /** Файли бібліотеки на таймлайн (панель, drop): по черзі від моменту `at`. */
  const addAssets = useCallback(
    async (ids: string[], at: number, trackId?: string) => {
      const known = { ...assetsRef.current };
      const need = ids.filter((id) => !isPresent(known[id]));
      if (need.length) Object.assign(known, await fetchAssets(need));
      let cursor = at;
      for (const id of ids) {
        const a = known[id];
        if (!isPresent(a) || ('status' in a && a.status !== 'ready')) {
          toast.error('Файл ще обробляється або недоступний');
          continue;
        }
        const info = assetInfo(a)!;
        let added: string[] = [];
        store.getState().apply((d) => {
          const r = addClip(d, info, { at: cursor, trackId: a.kind === 'audio' ? undefined : trackId });
          added = r.clipIds;
          return r.doc;
        });
        const clip = added[0] ? findClip(store.getState().doc, added[0])?.clip : null;
        if (clip) cursor = clip.start + clip.duration;
      }
    },
    [fetchAssets, store],
  );

  /** Файли з ОС: одразу кліп з blob:-URL, паралельно — завантаження в бібліотеку. */
  const addFiles = useCallback(
    async (files: File[], at: number, trackId?: string) => {
      let cursor = at;
      for (const file of files) {
        const kind = kindForMime(file.type);
        if (!kind) {
          toast.error(`«${file.name}»: непідтримуваний тип файлу`);
          continue;
        }
        const [uploadId] = uploads.addFiles([file]);
        if (!uploadId) continue;
        const url = URL.createObjectURL(file);
        const meta = await readLocal(file, url, kind);
        const localId = `local:${uploadId}`;
        const local: LocalAsset = {
          id: localId,
          missing: false,
          local: true,
          kind,
          url,
          thumbUrl: null,
          peaksUrl: null,
          hasAudio: null,
          title: file.name,
          progress: 0,
          ...meta,
        };
        assetsRef.current = { ...assetsRef.current, [localId]: local };
        merge({ [localId]: local });
        localUploads.current.set(uploadId, localId);
        let first: string | undefined;
        store.getState().apply((d) => {
          const r = addClip(d, assetInfo(local)!, { at: cursor, trackId: kind === 'audio' ? undefined : trackId });
          first = r.clipIds[0];
          return r.doc;
        });
        const clip = first ? findClip(store.getState().doc, first)?.clip : null;
        if (clip) cursor = clip.start + clip.duration;
      }
    },
    [uploads, store, merge],
  );

  /** «Перезавантажити» після конфлікту: серверна версія, локальні зміни відкинуто. */
  const reload = useCallback(async () => {
    const fresh = await trpcClient.projects.get.query({ id: project.id });
    store.getState().replaceDoc(fresh.timeline);
    merge(fresh.assets);
    autosave.reset(fresh.version);
    void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: project.id }) });
  }, [project.id, store, merge, autosave, qc, trpc]);

  /** «Перезаписати моєю версією»: зберегти поверх актуальної версії. */
  const overwrite = useCallback(async () => {
    const fresh = await trpcClient.projects.get.query({ id: project.id });
    autosave.setVersion(fresh.version);
    autosave.change(store.getState().doc);
    await autosave.flush();
  }, [project.id, autosave, store]);

  const seek = useCallback((t: number) => engine.seek(t), [engine]);
  const togglePlay = useCallback(() => {
    const playing = !ui.getState().playing;
    if (playing) engine.play();
    else engine.pause();
    ui.getState().set({ playing });
  }, [engine, ui]);

  const pendingUploads = useMemo(
    () =>
      Object.values(assets).some((a) => isPresent(a) && 'local' in a) ||
      assetIdsOf(doc).some((id) => id.startsWith('local:')),
    [assets, doc],
  );

  return {
    store,
    ui,
    engine,
    doc,
    assets,
    saveState,
    autosave,
    addAssets,
    addFiles,
    reload,
    overwrite,
    seek,
    togglePlay,
    pendingUploads,
  };
}
