import type { AssetKind, Orientation } from '@vf/shared';

export interface LibrarySearch {
  q?: string;
  kind?: AssetKind;
  source?: 'uploaded' | 'generated';
  orientation?: Orientation;
  tags?: string[];
  /** Відкрита картка файлу (посилання «Відкрити в бібліотеці» з редактора) */
  open?: string;
}

const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined =>
  typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : undefined;

/** Стан фільтрів живе в URL — посилання на пошук можна зберегти */
export function validateLibrarySearch(raw: Record<string, unknown>): LibrarySearch {
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : undefined;
  return {
    q: typeof raw.q === 'string' && raw.q.trim() ? raw.q : undefined,
    kind: oneOf(raw.kind, ['image', 'video', 'audio'] as const),
    source: oneOf(raw.source, ['uploaded', 'generated'] as const),
    orientation: oneOf(raw.orientation, ['vertical', 'horizontal', 'square'] as const),
    tags: tags?.length ? tags : undefined,
    open: typeof raw.open === 'string' && raw.open ? raw.open : undefined,
  };
}
