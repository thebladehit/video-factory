/** Періодичні задачі (прибирання тощо). Зараз — таймери в процесі; потім — повторювані задачі BullMQ. */
export interface Scheduler {
  every(name: string, ms: number, fn: () => Promise<void>, opts?: { runOnStart?: boolean }): void;
  stop(): void;
}

export function createIntervalScheduler(
  log: (msg: string, e: unknown) => void = (msg, e) => console.error(msg, e),
): Scheduler {
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  return {
    every(name, ms, fn, { runOnStart = false } = {}) {
      let busy = false;
      const tick = async () => {
        // повільний запуск не накладається на наступний
        if (busy || stopped) return;
        busy = true;
        try {
          await fn();
        } catch (e) {
          log(`[scheduler] ${name} завершився з помилкою:`, e);
        } finally {
          busy = false;
        }
      };
      timers.add(setInterval(tick, ms));
      if (runOnStart) {
        const t = setTimeout(() => {
          timers.delete(t);
          void tick();
        }, 0);
        timers.add(t);
      }
    },
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
