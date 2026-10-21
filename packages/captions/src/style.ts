import { z } from 'zod';
import { FONTS, type FontId } from './fonts';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const fontIds = FONTS.map((f) => f.id) as [FontId, ...FontId[]];

export const captionStyleSchema = z.object({
  font: z.enum(fontIds),
  /** % висоти кадру */
  size: z.number().min(3).max(12),
  color: hex,
  activeColor: hex,
  /** px при 1080p */
  outline: z.object({ color: hex, width: z.number().min(0).max(20) }),
  shadow: z.number().min(0).max(20),
  box: z.object({ enabled: z.boolean(), color: hex, opacity: z.number().min(0).max(1) }),
  /** marginY — % висоти кадру */
  position: z.object({ align: z.enum(['bottom', 'middle', 'top']), marginY: z.number().min(0).max(50) }),
  maxWordsPerLine: z.number().int().min(1).max(8),
  maxLines: z.union([z.literal(1), z.literal(2)]),
  uppercase: z.boolean(),
  animation: z.enum(['none', 'highlight', 'pop', 'karaoke']),
});

export type CaptionStyle = z.infer<typeof captionStyleSchema>;
