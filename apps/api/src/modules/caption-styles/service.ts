import { and, eq } from 'drizzle-orm';
import { captionStyleSchema } from '@vf/captions';
import { captionStyles } from '@vf/db';
import { AppError } from '@vf/shared';
import type { AppDeps } from '../../app';
import { isUuid } from '../projects/editor-assets';
import { listCaptionStyles, type CaptionStyleView } from '../voice/service';

export { listCaptionStyles };

const parseStyle = (raw: unknown) => {
  const r = captionStyleSchema.safeParse(raw);
  if (!r.success)
    throw new AppError('VALIDATION', 'Некоректний стиль субтитрів', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return r.data;
};

const parseName = (name: string) => {
  const n = name.trim();
  if (!n || n.length > 100) throw new AppError('VALIDATION', 'Назва стилю: від 1 до 100 символів');
  return n;
};

async function view(deps: AppDeps, userId: string, id: string): Promise<CaptionStyleView> {
  const found = (await listCaptionStyles(deps, userId)).find((s) => s.id === id);
  if (!found) throw new AppError('NOT_FOUND', 'Стиль не знайдено');
  return found;
}

export async function createCaptionStyle(
  deps: AppDeps,
  userId: string,
  input: { name: string; style: unknown },
): Promise<CaptionStyleView> {
  const [row] = await deps.db
    .insert(captionStyles)
    .values({ userId, name: parseName(input.name), style: parseStyle(input.style) })
    .returning({ id: captionStyles.id });
  return view(deps, userId, row!.id);
}

export async function updateCaptionStyle(
  deps: AppDeps,
  userId: string,
  input: { id: string; name?: string; style?: unknown },
): Promise<CaptionStyleView> {
  if (!isUuid(input.id)) throw new AppError('NOT_FOUND', 'Стиль не знайдено');
  const patch: Partial<typeof captionStyles.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = parseName(input.name);
  if (input.style !== undefined) patch.style = parseStyle(input.style);
  const [row] = await deps.db
    .update(captionStyles)
    .set(patch)
    .where(and(eq(captionStyles.id, input.id), eq(captionStyles.userId, userId)))
    .returning({ id: captionStyles.id });
  if (!row) throw new AppError('NOT_FOUND', 'Стиль не знайдено');
  return view(deps, userId, row.id);
}

export async function deleteCaptionStyle(deps: AppDeps, userId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Стиль не знайдено');
  const rows = await deps.db
    .delete(captionStyles)
    .where(and(eq(captionStyles.id, id), eq(captionStyles.userId, userId)))
    .returning({ id: captionStyles.id });
  if (!rows.length) throw new AppError('NOT_FOUND', 'Стиль не знайдено');
}
