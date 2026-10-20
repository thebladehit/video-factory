import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { TERMINAL_STATUSES, validateUpload } from '@vf/shared';
import { useJobFeed } from '@/lib/job-feed';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { DropOverlay } from './DropOverlay';
import { UploadPanel } from './UploadPanel';
import { createUppy, type UploadMeta } from './uppy';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type UppyFile = import('@uppy/core').UppyFile<UploadMeta, {}>;

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  bytesPerSec: number;
  state: 'uploading' | 'processing' | 'done' | 'error';
  error?: string;
  assetId?: string;
}

interface UploadsApi {
  addFiles(files: File[]): void;
  items: UploadItem[];
  cancel(id: string): void;
  retry(id: string): void;
  clearFinished(): void;
}

const UploadsContext = createContext<UploadsApi | null>(null);

export function useUploads(): UploadsApi {
  const ctx = useContext(UploadsContext);
  if (!ctx) throw new Error('useUploads поза UploadProvider');
  return ctx;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Завантаження будь-де в застосунку: drop на вікно, кнопки «Завантажити», панель прогресу. */
export function UploadProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [uppy] = useState(() => createUppy(trpcClient));
  const [items, setItems] = useState<UploadItem[]>([]);
  const speed = useRef(new Map<string, { at: number; bytes: number }>());

  const patch = useCallback((id: string, p: Partial<UploadItem>) => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)));
  }, []);
  const refreshLibrary = useCallback(() => qc.invalidateQueries({ queryKey: trpc.assets.pathKey() }), [qc, trpc]);

  useEffect(() => {
    const onAdded = (file: UppyFile) => {
      setItems((list) => [
        ...list,
        { id: file.id, name: file.name ?? 'файл', progress: 0, bytesPerSec: 0, state: 'uploading' },
      ]);
    };
    const onProgress = (file: UppyFile | undefined, p: { bytesUploaded: number; bytesTotal: number | null }) => {
      if (!file || !p.bytesTotal) return;
      const now = Date.now();
      const prev = speed.current.get(file.id);
      const bytes = p.bytesUploaded;
      const bytesPerSec = prev && now > prev.at ? ((bytes - prev.bytes) * 1000) / (now - prev.at) : 0;
      speed.current.set(file.id, { at: now, bytes });
      patch(file.id, {
        progress: (bytes / p.bytesTotal) * 100,
        bytesPerSec: Math.max(0, bytesPerSec),
        assetId: file.meta.assetId,
      });
    };
    const onSuccess = async (file: UppyFile | undefined) => {
      if (!file) return;
      const assetId = file.meta.assetId;
      try {
        // одиночний PUT підтверджуємо тут; multipart підтвердив completeMultipartUpload
        const status =
          file.meta.mode === 'single' && assetId
            ? (await trpcClient.assets.complete.mutate({ assetId })).status
            : 'processing';
        patch(file.id, { progress: 100, assetId, state: status === 'ready' ? 'done' : 'processing' });
      } catch (e) {
        patch(file.id, { state: 'error', error: message(e) });
      }
      uppy.removeFile(file.id); // щоб той самий файл можна було закинути ще раз
      void refreshLibrary();
    };
    const onError = (file: UppyFile | undefined, error: { message: string }) => {
      if (file) patch(file.id, { state: 'error', error: error.message, assetId: file.meta.assetId });
    };
    // Uppy живе весь час роботи застосунку; cleanup лише знімає обробники (StrictMode монтує ефекти двічі)
    uppy.on('file-added', onAdded);
    uppy.on('upload-progress', onProgress);
    uppy.on('upload-success', onSuccess);
    uppy.on('upload-error', onError);
    return () => {
      uppy.off('file-added', onAdded);
      uppy.off('upload-progress', onProgress);
      uppy.off('upload-success', onSuccess);
      uppy.off('upload-error', onError);
    };
  }, [uppy, patch, refreshLibrary]);

  useJobFeed(async (e) => {
    if (e.type !== 'asset.process' || !e.subject.assetId || !TERMINAL_STATUSES.has(e.status)) return;
    const item = items.find((i) => i.assetId === e.subject.assetId && i.state === 'processing');
    void refreshLibrary();
    if (!item) return;
    try {
      const asset = await trpcClient.assets.get.query({ id: item.assetId! });
      patch(
        item.id,
        asset.status === 'ready' ? { state: 'done' } : { state: 'error', error: asset.error ?? 'Помилка обробки' },
      );
    } catch (err) {
      patch(item.id, { state: 'error', error: message(err) });
    }
  });

  const uploading = items.some((i) => i.state === 'uploading');
  useEffect(() => {
    if (!uploading) return;
    const warn = (ev: BeforeUnloadEvent) => ev.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  const api: UploadsApi = {
    items,
    addFiles(files) {
      for (const file of files) {
        try {
          validateUpload({ name: file.name, mime: file.type, size: file.size });
          uppy.addFile({ name: file.name, type: file.type, data: file, source: 'local' });
        } catch (e) {
          toast.error(message(e));
        }
      }
    },
    cancel(id) {
      const item = items.find((i) => i.id === id);
      const file = uppy.getFile(id);
      // multipart скасовує сам Uppy (abortMultipartUpload); одиночний — прибираємо рядок asset
      if (file?.meta.mode === 'single' && file.meta.assetId)
        void trpcClient.assets.abort.mutate({ assetId: file.meta.assetId });
      if (file) uppy.removeFile(id);
      if (item) setItems((list) => list.filter((i) => i.id !== id));
    },
    retry(id) {
      const item = items.find((i) => i.id === id);
      if (uppy.getFile(id)) {
        patch(id, { state: 'uploading', error: undefined });
        void uppy.retryUpload(id);
      } else if (item?.assetId) {
        patch(id, { state: 'processing', error: undefined });
        trpcClient.assets.retryProcess
          .mutate({ id: item.assetId })
          .catch((e) => patch(id, { state: 'error', error: message(e) }));
      }
    },
    clearFinished() {
      setItems((list) => list.filter((i) => i.state !== 'done'));
    },
  };

  return (
    <UploadsContext.Provider value={api}>
      {children}
      <DropOverlay onFiles={api.addFiles} />
      <UploadPanel />
    </UploadsContext.Provider>
  );
}
