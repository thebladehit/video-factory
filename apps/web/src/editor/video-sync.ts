/**
 * Куди поставити відео-елемент кліпу. Кліп на всю довжину джерела може «пережити» справжній кінець файлу
 * (durationMs трохи більший) — тоді тримаємо останній кадр на паузі: `play()` закінченого елемента
 * починає з нуля, і в прев'ю блимав би перший кадр (рендер тримає останній — tpad=clone).
 */
export function videoTarget(sourceTime: number, duration: number, fps: number): { time: number; hold: boolean } {
  if (!Number.isFinite(duration) || duration <= 0) return { time: sourceTime, hold: false };
  const last = duration - 1 / fps;
  if (sourceTime >= last) return { time: Math.max(0, duration - 1 / (2 * fps)), hold: true };
  return { time: sourceTime, hold: false };
}
