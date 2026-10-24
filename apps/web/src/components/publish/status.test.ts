import { describe, expect, it } from 'vitest';
import { statusLabel } from './status';

// локальний час: підпис показує годинник браузера, тож і вхід будуємо в локальному часовому поясі
const local = (month: number, day: number, h: number, m: number) => new Date(2026, month - 1, day, h, m).toISOString();
const now = new Date(2026, 9, 23, 12, 0);

describe('statusLabel', () => {
  it('scheduled — дата й час виходу', () => {
    expect(statusLabel({ status: 'scheduled', platform: 'tiktok', scheduledAt: local(10, 24, 18, 0) }, now)).toBe(
      'Заплановано · 24.10 18:00',
    );
  });

  it('scheduled без часу — просто «Заплановано»', () => {
    expect(statusLabel({ status: 'scheduled', platform: 'youtube', scheduledAt: null }, now)).toBe('Заплановано');
  });

  it('published із майбутнім scheduled_at на YouTube — нативний розклад', () => {
    expect(statusLabel({ status: 'published', platform: 'youtube', scheduledAt: local(10, 25, 9, 30) }, now)).toBe(
      'Заплановано на YouTube · 25.10 09:30',
    );
  });

  it('published без розкладу чи з минулим часом — «Опубліковано»', () => {
    expect(statusLabel({ status: 'published', platform: 'youtube', scheduledAt: local(10, 22, 9, 30) }, now)).toBe(
      'Опубліковано',
    );
    expect(statusLabel({ status: 'published', platform: 'tiktok', scheduledAt: null }, now)).toBe('Опубліковано');
  });

  it('uploading — прогрес задачі', () => {
    expect(statusLabel({ status: 'uploading', platform: 'youtube', scheduledAt: null, progress: 42 }, now)).toBe(
      'Завантаження 42 %',
    );
    expect(statusLabel({ status: 'uploading', platform: 'youtube', scheduledAt: null, progress: 41.6 }, now)).toBe(
      'Завантаження 42 %',
    );
  });

  it('інші стани', () => {
    const at = { platform: 'youtube' as const, scheduledAt: null };
    expect(statusLabel({ ...at, status: 'processing' }, now)).toBe('Обробка на YouTube');
    expect(statusLabel({ ...at, status: 'awaiting_manual' }, now)).toBe('Чекає на вас');
    expect(statusLabel({ ...at, status: 'failed' }, now)).toBe('Помилка');
    expect(statusLabel({ ...at, status: 'cancelled' }, now)).toBe('Скасовано');
  });

  it('інший рік — з роком', () => {
    expect(
      statusLabel(
        { status: 'scheduled', platform: 'tiktok', scheduledAt: new Date(2027, 0, 2, 8, 5).toISOString() },
        now,
      ),
    ).toBe('Заплановано · 02.01.2027 08:05');
  });
});
