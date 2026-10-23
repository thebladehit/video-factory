/**
 * Сховище розкладки панелей для `useDefaultLayout`. localStorage лише в try/catch: у приватному режимі чи з
 * вимкненим сховищем розкладка просто не зберігається. Бібліотека розбирає збережене значення без перевірки —
 * зіпсоване значення (не JSON-об'єкт) віддається як `null`, інакше редактор не відкрився б.
 */
export const layoutStorage = {
  getItem(key: string): string | null {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? raw : null;
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* сховище недоступне */
    }
  },
};
