import { z } from 'zod';

export const PLATFORMS = ['youtube', 'tiktok', 'instagram', 'facebook'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
};

export const PUBLISH_METHODS = ['api', 'manual'] as const;
export type PublishMethod = (typeof PUBLISH_METHODS)[number];

export const PUBLICATION_STATUSES = [
  'scheduled',
  'uploading',
  'processing',
  'published',
  'awaiting_manual',
  'failed',
  'cancelled',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** Публікація, що ще «в роботі»: блокує дублі й видалення проєкту/рендеру. */
export const LIVE_PUBLICATION_STATUSES: ReadonlySet<PublicationStatus> = new Set([
  'scheduled',
  'uploading',
  'processing',
  'awaiting_manual',
]);

export const ACCOUNT_STATUSES = ['active', 'reauth_required'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const publicationMetaSchema = z.object({
  /** TikTok/Instagram — порожньо (у них немає назви) */
  title: z.string(),
  /** Для TikTok/Instagram/Facebook — підпис */
  description: z.string(),
  /** YouTube — tags; інші — хештеги без «#» */
  tags: z.array(z.string()),
  privacy: z.enum(['public', 'unlisted', 'private']).optional(),
  madeForKids: z.boolean().optional(),
  categoryId: z.string().optional(),
});
export type PublicationMeta = z.infer<typeof publicationMetaSchema>;
