/**
 * Чернетка тексту рядка: збереження з debounce і при flush; `dispose` (розмонтування) не губить правку.
 * Кожна чернетка прив'язана до свого `save` — при зміні мови/сегмента створюється нова.
 *
 * - `save` може повернути проміс: поки збереження не завершилось, `sync` ігнорує сервер (запит, що почався
 *   раніше за збереження, приніс би старий текст і затер би правку).
 * - `normalize` (напр. trim, як робить сервер): зберігається нормалізований текст; значення з сервера, що
 *   збігається з нормалізованим локальним, не замінює локальне (інакше «aerial view » → «aerial view» посеред набору).
 */
export function createTextDraft(opts: {
  value: string;
  save(text: string): void | Promise<unknown>;
  delayMs: number;
  normalize?(text: string): string;
}) {
  const norm = opts.normalize ?? ((t: string) => t);
  let value = opts.value;
  let latest = opts.value;
  let dirty = false;
  let inFlight = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    const text = norm(latest);
    if (text === norm(value)) return;
    // далі порівнюємо з тим, що вже відправлено (а не з останнім значенням із сервера)
    value = text;
    const r = opts.save(text);
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      inFlight++;
      void (r as Promise<unknown>).then(
        () => void inFlight--,
        () => void inFlight--,
      );
    }
  }
  return {
    change(text: string) {
      latest = text;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(flush, opts.delayMs);
    },
    flush,
    /** Нове значення з сервера: що показати (`null` — лишити як є: є правка, триває збереження або текст той самий). */
    sync(next: string): string | null {
      value = next;
      if (dirty || inFlight > 0) return null;
      if (latest !== next && norm(latest) === norm(next)) return null;
      latest = next;
      return next;
    },
    /** Чи є незбережена або ще не підтверджена сервером правка */
    pending: () => dirty || inFlight > 0,
    dispose: flush,
  };
}
