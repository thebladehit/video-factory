/**
 * Чернетка тексту рядка: збереження з debounce і при flush; `dispose` (розмонтування) не губить правку.
 * Кожна чернетка прив'язана до свого `save` — при зміні мови/сегмента створюється нова.
 */
export function createTextDraft(opts: { value: string; save(text: string): void; delayMs: number }) {
  let value = opts.value;
  let latest = opts.value;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    if (latest !== value) opts.save(latest);
  }
  return {
    change(text: string) {
      latest = text;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(flush, opts.delayMs);
    },
    flush,
    /** Нове значення з сервера: що показати (`null` — лишити як є, бо є непорожня правка). */
    sync(next: string): string | null {
      value = next;
      if (dirty) return null;
      latest = next;
      return next;
    },
    dispose: flush,
  };
}
