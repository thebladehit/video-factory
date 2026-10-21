/**
 * Зливає часті події задач в один запит через `delayMs`. Якщо серед злитих подій була завершальна —
 * виконується `onTerminal` (навіть коли пізніша подія прогресу перезапустила таймер), інакше `onProgress`.
 */
export function createEventCoalescer(o: { delayMs: number; onProgress(): void; onTerminal(): void }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminalSeen = false;
  return {
    push(terminal: boolean) {
      if (terminal) terminalSeen = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const t = terminalSeen;
        terminalSeen = false;
        timer = undefined;
        if (t) o.onTerminal();
        else o.onProgress();
      }, o.delayMs);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
