/** Файл з ОС, що відстежується редактором: поточний id у документі й чи він ще локальний. */
export interface TrackedUpload {
  id: string;
  local: boolean;
}

interface UploadLike {
  id: string;
  name: string;
  progress: number;
  state: 'uploading' | 'processing' | 'done' | 'error';
  assetId?: string;
  error?: string;
}

export type UploadAction =
  | { type: 'rewrite'; uploadId: string; from: string; to: string }
  | { type: 'progress'; id: string; progress: number }
  /** Завантаження не вдалося або скасоване: прибрати кліпи й локальний файл */
  | { type: 'failed'; uploadId: string; id: string; message: string }
  | { type: 'forget'; uploadId: string };

/** Що зробити з файлами з ОС після зміни списку завантажень (чиста функція — стан змінює редактор). */
export function reconcileUploads(items: UploadLike[], tracked: Map<string, TrackedUpload>): UploadAction[] {
  const out: UploadAction[] = [];
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const [uploadId, t] of tracked) {
    const item = byId.get(uploadId);
    if (!t.local) {
      out.push({ type: 'forget', uploadId });
      continue;
    }
    if (!item) {
      out.push({ type: 'failed', uploadId, id: t.id, message: 'Завантаження скасовано' });
    } else if (item.state === 'error') {
      out.push({
        type: 'failed',
        uploadId,
        id: t.id,
        message: `Не вдалося завантажити «${item.name}»: ${item.error ?? 'помилка'}`,
      });
    } else if (item.assetId && item.assetId !== t.id) {
      out.push({ type: 'rewrite', uploadId, from: t.id, to: item.assetId });
    } else {
      out.push({ type: 'progress', id: t.id, progress: item.progress });
    }
  }
  return out;
}
