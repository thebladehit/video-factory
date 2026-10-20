import { z } from 'zod';

export const FORMATS = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
} as const;
export type VideoFormat = keyof typeof FORMATS;

const id = z.string().min(1);
const time = z.number().finite().min(0);
const positive = z.number().finite().positive();

const effectSchema = z.object({
  type: z.enum(['kenburns', 'fade', 'xfade', 'zoom']),
  params: z.record(z.string(), z.number()),
});

const mediaClipSchema = z.object({
  id,
  assetId: id,
  start: time,
  duration: positive,
  in: time,
  sceneId: id.optional(),
  fit: z.enum(['cover', 'contain']),
  effects: z.array(effectSchema),
});

const audioClipSchema = z.object({
  id,
  assetId: id,
  start: time,
  duration: positive,
  in: time,
  volume: z.number().min(0).max(2),
  sceneId: id.optional(),
  fadeIn: time.optional(),
  fadeOut: time.optional(),
});

const captionClipSchema = z.object({ id, audioClipId: id, transcriptId: id, styleId: id });

const trackSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('video'), clips: z.array(mediaClipSchema) }),
  z.object({
    id,
    kind: z.literal('audio'),
    clips: z.array(audioClipSchema),
    role: z.enum(['voiceover', 'music', 'sfx']),
    language: z.string().min(2).optional(),
  }),
  z.object({ id, kind: z.literal('captions'), clips: z.array(captionClipSchema), language: z.string().min(2) }),
]);

export const timelineDocSchema = z.object({
  schemaVersion: z.literal(1),
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(7680),
  fps: z.number().int().min(1).max(120),
  tracks: z.array(trackSchema),
});

export type TimelineDoc = z.infer<typeof timelineDocSchema>;
export type Track = z.infer<typeof trackSchema>;
export type MediaClip = z.infer<typeof mediaClipSchema>;
export type AudioClip = z.infer<typeof audioClipSchema>;
export type CaptionClip = z.infer<typeof captionClipSchema>;
export type Effect = z.infer<typeof effectSchema>;

export const emptyTimeline = (format: VideoFormat, fps = 30): TimelineDoc => ({
  schemaVersion: 1,
  ...FORMATS[format],
  fps,
  tracks: [],
});
