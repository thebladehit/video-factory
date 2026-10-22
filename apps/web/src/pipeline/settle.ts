/**
 * Чекає, поки `busy()` стане false (перевірка кожні `stepMs`), але не довше за `timeoutMs`.
 * Перша перевірка — після поточної задачі: blur перед кліком щойно поставив збереження.
 * Повертає true, якщо дочекались.
 */
export async function waitUntilIdle(busy: () => boolean, o: { stepMs: number; timeoutMs: number }): Promise<boolean> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(0);
  for (let waited = 0; busy(); waited += o.stepMs) {
    if (waited >= o.timeoutMs) return false;
    await sleep(o.stepMs);
  }
  return true;
}
