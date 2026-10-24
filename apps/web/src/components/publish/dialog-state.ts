import { LIVE_PUBLICATION_STATUSES, type Platform, type PublicationMeta, type PublicationStatus } from '@vf/shared';

/** Статуси, за яких цю версію вдруге на той самий акаунт не пропонуємо */
const BLOCKING: readonly string[] = [...LIVE_PUBLICATION_STATUSES, 'published' satisfies PublicationStatus];

/** Публікація цієї версії (рендеру) на цей акаунт, що вже в роботі чи опублікована */
export function blockingPublication<P extends { renderId: string; accountId: string; status: string }>(
  publications: readonly P[],
  renderId: string,
  accountId: string,
): P | undefined {
  return publications.find((p) => p.renderId === renderId && p.accountId === accountId && BLOCKING.includes(p.status));
}

/** Поля метаданих, що відрізняються */
export function changedFields(prev: PublicationMeta, next: PublicationMeta): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter(
    (k) => JSON.stringify(prev[k as keyof PublicationMeta]) !== JSON.stringify(next[k as keyof PublicationMeta]),
  );
}

type Metas = Partial<Record<Platform, PublicationMeta>>;

/** Результат AI поверх поточних метаданих: поля, які користувач уже змінив, лишаються його */
export function mergeGenerated(
  variants: Metas,
  current: Metas | undefined,
  edited: Partial<Record<Platform, ReadonlySet<string>>>,
): Metas {
  const out: Metas = { ...current };
  for (const [pl, generated] of Object.entries(variants) as [Platform, PublicationMeta][]) {
    const mine = current?.[pl];
    const fields = edited[pl];
    if (!mine || !fields?.size) {
      out[pl] = generated;
      continue;
    }
    const kept = Object.fromEntries([...fields].map((f) => [f, mine[f as keyof PublicationMeta]]));
    out[pl] = { ...generated, ...kept };
  }
  return out;
}
