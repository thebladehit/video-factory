import type { Platform, PublicationStatus } from '@vf/shared';

export interface StatusInput {
  status: PublicationStatus;
  platform: Platform;
  scheduledAt: string | null;
  /** Прогрес задачі `publish` із SSE (0–100), лише для `uploading` */
  progress?: number;
}

const two = (n: number) => String(n).padStart(2, '0');

/** «24.10 18:00» у локальному часі браузера; інший рік — «02.01.2027 08:05» */
export function formatWhen(iso: string, now: Date): string {
  const d = new Date(iso);
  const date = `${two(d.getDate())}.${two(d.getMonth() + 1)}`;
  const year = d.getFullYear() === now.getFullYear() ? '' : `.${d.getFullYear()}`;
  return `${date}${year} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Підпис статус-бейджа комірки матриці */
export function statusLabel(p: StatusInput, now: Date): string {
  switch (p.status) {
    case 'scheduled':
      return p.scheduledAt ? `Заплановано · ${formatWhen(p.scheduledAt, now)}` : 'Заплановано';
    case 'uploading':
      return p.progress === undefined ? 'Завантаження' : `Завантаження ${Math.round(p.progress)} %`;
    case 'processing':
      return 'Обробка на YouTube';
    case 'published':
      // нативний розклад YouTube: відео вже завантажене, але вийде пізніше
      if (p.platform === 'youtube' && p.scheduledAt && new Date(p.scheduledAt).getTime() > now.getTime()) {
        return `Заплановано на YouTube · ${formatWhen(p.scheduledAt, now)}`;
      }
      return 'Опубліковано';
    case 'awaiting_manual':
      return 'Чекає на вас';
    case 'failed':
      return 'Помилка';
    case 'cancelled':
      return 'Скасовано';
  }
}

export type StatusTone = 'default' | 'secondary' | 'destructive' | 'outline';

/** Варіант бейджа: «Чекає на вас» — акцент, помилка — червоний, кінцеві — приглушені */
export function statusTone(status: PublicationStatus): StatusTone {
  if (status === 'failed') return 'destructive';
  if (status === 'awaiting_manual') return 'default';
  if (status === 'published') return 'secondary';
  return 'outline';
}
