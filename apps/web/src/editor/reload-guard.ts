import type { TimelineDoc } from '@vf/shared';

/**
 * Серверну версію можна класти в стор, лише якщо за час запиту користувач нічого не змінив:
 * документ у сторі той самий, що й до запиту, і автозбереження не має незбереженого.
 */
export const canReplaceDoc = (before: TimelineDoc, current: TimelineDoc, hasPending: boolean): boolean =>
  !hasPending && before === current;
