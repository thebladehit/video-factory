export interface VideoTarget {
  /** Час у джерелі, куди поставити елемент. */
  time: number;
  /** Тримати кадр на паузі (зона `hold` або кінець файлу). */
  paused: boolean;
  playbackRate: number;
}

const EPS = 1e-9;

/**
 * Куди поставити відео-елемент кліпу в момент `t` документа.
 * - Темп: `playbackRate = speed`, джерело — `in + local × speed`.
 * - Зона `hold` (останні `hold` с кліпу): пауза на останньому декодованому кадрі — як у рендері (вхід ffmpeg
 *   обрізано до `(duration − hold) × speed`, `tpad=clone` повторює останній кадр), тобто кадр за `1/fps` до межі.
 * - Кліп на всю довжину джерела може «пережити» справжній кінець файлу (durationMs трохи більший) — тоді теж
 *   тримаємо останній кадр на паузі: `play()` закінченого елемента починає з нуля, і в прев'ю блимав би перший кадр.
 */
export function videoTarget(
  clip: { start: number; duration: number; in: number; speed?: number; hold?: number },
  t: number,
  mediaDuration: number,
  fps: number,
): VideoTarget {
  const speed = clip.speed ?? 1;
  const played = clip.duration - (clip.hold ?? 0);
  const local = Math.max(0, t - clip.start);
  let time = clip.in + local * speed;
  let paused = false;
  if ((clip.hold ?? 0) > 0 && local >= played - EPS) {
    time = Math.max(clip.in, clip.in + played * speed - 1 / fps);
    paused = true;
  }
  if (Number.isFinite(mediaDuration) && mediaDuration > 0 && time >= mediaDuration - 1 / fps) {
    time = Math.max(0, mediaDuration - 1 / (2 * fps));
    paused = true;
  }
  return { time, paused, playbackRate: speed };
}
