import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { bindAutosave } from './mode-sync';
import { createEditorStore, createUiStore, isReadOnlyState, type EditorMode } from './store';
import { isPresent, type AnyAsset, type LocalAsset } from './types';
import { createVoiceSync } from './voice-sync';

const REFRESH_BEFORE_MS = 5 * 60_000;
export const PHOTO_SECONDS = 5;

/** Ключ автозбереження в реєстрі: базовий документ — '', мова — її код */
const BASE_KEY = '';
const keyOf = (m: EditorMode): string | null => (m.kind === 'edit' ? BASE_KEY : m.separated ? m.language : null);

const READ_ONLY_HINT = (frozen: boolean) =>
  frozen ? 'Конвеєр ще працює — редагування після збірки' : 'Перегляд мови — редагування в «Монтажі»';

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

  /** Ключ автозбереження, чий стан показується (стани решти ігноруються) */
  const activeKey = useRef<string | null>(BASE_KEY);
  /** Автозбереження документів: базового ('') і відокремлених мов; кожне пише лише у свій документ */
  const [saves] = useState(() => {
    const map = new Map<string, Autosave>();
    const make = (key: string, version: number) =>
      new Autosave({
        save: (timeline, baseVersion) =>
          trpcClient.projects.save.mutate({
            id: project.id,
            ...(key === BASE_KEY ? {} : { language: key }),
            timeline,
            baseVersion,
          }),
        debounceMs: 1500,
        version,
        onState: (s) => {
          if (activeKey.current === key) setSaveState(s);
        },
      });
    map.set(BASE_KEY, make(BASE_KEY, project.version));
    return { map, make };
  });
  const autosave = saves.map.get(BASE_KEY)!;
  const mode = useStore(store, (s) => s.mode);
  const [subtitles, setSubtitles] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  /** Конвеєр ще збирає чернетку: документ лише для перегляду (зсувається тільки в `false`) */
  const [pipelineLive, setPipelineLive] = useState(
    () => project.pipeline?.status === 'running' || project.pipeline?.status === 'awaiting_review',
  );
  const frozen = useStore(store, (s) => s.frozen);
  const readOnly = isReadOnlyState({ mode, frozen });
  useEffect(() => store.getState().setFrozen(pipelineLive), [store, pipelineLive]);
  /** Глибина «замків»: поки йде перемикання/відокремлення, стор лише для читання */
  const lockDepth = useRef(0);
  const locked = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T> => {
      if (lockDepth.current++ === 0) store.getState().setLocked(true);
      try {
        return await fn();
      } finally {
        if (--lockDepth.current === 0) store.getState().setLocked(false);
      }
    },
    [store],
  );
  const activeAutosave = useCallback(() => {
    const k = keyOf(store.getState().mode);
    return k === null ? null : (saves.map.get(k) ?? null);
  }, [store, saves]);

  // документ → автозбереження свого режиму; файли з бібліотеки, яких ще немає в мапі
  useEffect(() => {
    const off = bindAutosave(store, (m) => {
      const k = keyOf(m);
      return k === null ? null : (saves.map.get(k) ?? null);
    });
    let prev = store.getState().doc;
    const off2 = store.subscribe((s) => {
      if (s.doc === prev) return;
      prev = s.doc;
      const unknown = assetIdsOf(s.doc).filter((id) => !(id in assetsRef.current) && !awaiting.current.has(id));
      if (unknown.length) void fetchAssets(unknown);
    });
    return () => {
      off();
      off2();
    };
  }, [store, saves, fetchAssets]);

  // доріжка озвучки базової мови ← готові дублі `voice.get` (спека §3.2, виклик 2): нові дані, «Монтаж», не заморожено
  const voice = useQuery(trpc.voice.get.queryOptions({ projectId: project.id }));
  const [voiceSync] = useState(createVoiceSync);
  const lockedNow = useStore(store, (s) => s.locked);
  const gesturing = useStore(store, (s) => s.gesturing);
  useEffect(() => voiceSync.run(store, voice.data), [voiceSync, store, voice.data, mode, frozen, lockedNow, gesturing]);
  // дубль з'явився чи зник (інша вкладка студії) — свіжі дані; задачі озвучки адресовані рядку (`subject.lineId`)
  const lineIds = useMemo(
    () => new Set(Object.values(voice.data?.lines ?? {}).flatMap((byLang) => Object.values(byLang).map((l) => l.id))),
    [voice.data],
  );
  useJobFeed((e) => {
    if (!e.type.startsWith('voice.') || !TERMINAL_STATUSES.has(e.status)) return;
    if (e.subject.projectId !== project.id && !(e.subject.lineId && lineIds.has(e.subject.lineId))) return;
    void qc.invalidateQueries({ queryKey: trpc.voice.get.queryKey({ projectId: project.id }) });
  });

  const doc = useStore(store, (s) => s.doc);
  useEffect(() => engine.setDoc(doc, assets), [engine, doc, assets]);
  // субтитри — лише в мовному режимі (ASS приходить з сервера разом із документом мови)
  useEffect(() => engine.setSubtitles(mode.kind === 'language' ? subtitles : null), [engine, mode, subtitles]);

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
    const all = () => [...saves.map.values()];
    const onHide = () => {
      if (document.visibilityState === 'hidden') all().forEach((a) => void a.flush());
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (all().some((a) => a.hasPending())) {
        all().forEach((a) => void a.flush());
        e.preventDefault();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onUnload);
      [...saves.map.values()].forEach((a) => void a.flush());
    };
  }, [saves]);

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
      if (isReadOnlyState(store.getState())) return void toast.info(READ_ONLY_HINT(store.getState().frozen));
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
      if (isReadOnlyState(store.getState())) return void toast.info(READ_ONLY_HINT(store.getState().frozen));
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

  /**
   * Завантажити документ режиму з сервера й покласти в стор. Спершу зберігається поточний документ
   * (`discard` — ні: «Перезавантажити» після конфлікту відкидає локальні зміни). Не вдалося зберегти — режим не змінюється.
   */
  const loadMode = useCallback(
    (next: EditorMode, opts: { discard?: boolean } = {}): Promise<boolean> =>
      locked(async () => {
        const cur = activeAutosave();
        if (cur && !opts.discard) {
          await cur.flush();
          if (cur.hasPending()) {
            toast.error('Не вдалося зберегти проєкт — режим не змінено. Повторіть збереження.');
            return false;
          }
        }
        let nextDoc: TimelineDoc;
        let nextSubs: string | null = null;
        let nextMode: EditorMode = next;
        let key: string | null;
        let version = 0;
        if (next.kind === 'edit') {
          const fresh = await trpcClient.projects.get.query({ id: project.id });
          nextDoc = fresh.timeline;
          version = fresh.version;
          merge(fresh.assets);
          key = BASE_KEY;
        } else {
          const l = await trpcClient.voice.localized.query({ projectId: project.id, language: next.language });
          nextDoc = l.timeline;
          nextSubs = l.subtitles;
          version = l.version;
          merge(l.assets);
          nextMode = { kind: 'language', language: next.language, separated: l.separated };
          key = keyOf(nextMode);
        }
        if (key !== null) {
          const existing = saves.map.get(key);
          if (existing) existing.reset(version);
          else saves.map.set(key, saves.make(key, version));
        }
        // документ з сервера замість локального (конфлікт, збірка): синхронізація озвучки — знову;
        // звичайне перемикання режиму пам'ять не скидає (скасована синхронізація лишається скасованою)
        if (opts.discard) voiceSync.reset();
        engine.pause();
        ui.getState().set({ playing: false, selected: [], invalidClips: [] });
        activeKey.current = key;
        setSubtitles(nextSubs);
        setSaveState('saved');
        store.getState().switchMode(nextMode, nextDoc);
        return true;
      }),
    [project.id, store, merge, engine, ui, saves, activeAutosave, locked, voiceSync],
  );

  const switchTo = useCallback(
    async (next: EditorMode) => {
      setSwitching(true);
      try {
        await loadMode(next);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setSwitching(false);
      }
    },
    [loadMode],
  );

  /** «Відокремити мову»: поточний документ мови стає її власною копією → редагування. */
  const separate = useCallback(
    async (language: string) => {
      setSwitching(true);
      try {
        await locked(async () => {
          await trpcClient.voice.separate.mutate({ projectId: project.id, language });
          await loadMode({ kind: 'language', language, separated: true });
        });
        void qc.invalidateQueries({ queryKey: trpc.voice.get.queryKey({ projectId: project.id }) });
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setSwitching(false);
      }
    },
    [project.id, loadMode, locked, qc, trpc],
  );

  /** «Повернути до спільного»: власна копія мови видаляється (її незбережені зміни теж), далі — перегляд. */
  const unseparate = useCallback(
    async (language: string) => {
      setSwitching(true);
      try {
        await locked(async () => {
          // спершу дочекатися збереження, що вже йде; копію видаляє сервер — і лише після успіху скидаємо клієнтський стан
          await saves.map.get(language)?.flush();
          await trpcClient.voice.unseparate.mutate({ projectId: project.id, language });
          saves.map.get(language)?.reset(1);
          saves.map.delete(language);
          await loadMode({ kind: 'language', language, separated: false }, { discard: true });
        });
        void qc.invalidateQueries({ queryKey: trpc.voice.get.queryKey({ projectId: project.id }) });
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setSwitching(false);
      }
    },
    [project.id, loadMode, locked, saves, qc, trpc],
  );

  /** «Перезавантажити» після конфлікту: серверна версія поточного документа, локальні зміни відкинуто. */
  const reload = useCallback(async () => {
    await loadMode(store.getState().mode, { discard: true });
    void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: project.id }) });
  }, [project.id, store, loadMode, qc, trpc]);

  // конвеєр: збірку завершено → документ з сервера без модалки конфлікту (у режимі перегляду локальних змін немає);
  // інший кінець (збій, скасування) лише знімає заморожування
  useJobFeed((e) => {
    if (!pipelineLive || e.subject.projectId !== project.id || !e.type.startsWith('pipeline.')) return;
    if (!TERMINAL_STATUSES.has(e.status)) return;
    if (e.type === 'pipeline.assemble' && e.status === 'done') {
      void reload()
        .then(() => {
          setPipelineLive(false);
          void qc.invalidateQueries({ queryKey: trpc.voice.get.queryKey({ projectId: project.id }) });
        })
        .catch((err) => toast.error((err as Error).message));
      return;
    }
    void trpcClient.projects.get.query({ id: project.id }).then((fresh) => {
      if (fresh.pipeline?.status !== 'running' && fresh.pipeline?.status !== 'awaiting_review') setPipelineLive(false);
    });
  });

  /** «Перезаписати моєю версією»: зберегти поточний документ поверх актуальної версії. */
  const overwrite = useCallback(async () => {
    const m = store.getState().mode;
    const k = keyOf(m);
    const cur = k === null ? null : saves.map.get(k);
    if (!cur) return;
    const fresh = await trpcClient.projects.get.query({
      id: project.id,
      ...(m.kind === 'language' ? { language: m.language } : {}),
    });
    cur.setVersion(fresh.version);
    cur.change(store.getState().doc);
    await cur.flush();
  }, [project.id, saves, store]);

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
    activeAutosave,
    saves: saves.map,
    mode,
    readOnly,
    pipelineLive,
    switching,
    switchTo,
    separate,
    unseparate,
    addAssets,
    addFiles,
    reload,
    overwrite,
    seek,
    togglePlay,
    pendingUploads,
    voice: voice.data,
  };
}
