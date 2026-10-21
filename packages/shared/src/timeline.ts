import { z } from 'zod';
import { AppError } from './errors';

export const FORMATS = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
} as const;
export type VideoFormat = keyof typeof FORMATS;

const id = z.string().min(1);
const time = z.number().finite().min(0);
const positive = z.number().finite().positive();

const unit = z.number().finite().min(0).max(1);

/** Параметри ефектів: на вході необов'язкові (старі `params: {}`), на виході — заповнені замовчуваннями. */
export const EFFECT_DEFAULTS = {
  kenburns: { fromScale: 1, toScale: 1.15, fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5 },
  zoom: { scale: 1.2, x: 0.5, y: 0.5 },
  fade: { in: 0.3, out: 0 },
  xfade: { duration: 0.5 },
} as const;

const kb = EFFECT_DEFAULTS.kenburns;
const zm = EFFECT_DEFAULTS.zoom;
const effectSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('kenburns'),
    params: z.object({
      fromScale: positive.default(kb.fromScale),
      toScale: positive.default(kb.toScale),
      fromX: unit.default(kb.fromX),
      fromY: unit.default(kb.fromY),
      toX: unit.default(kb.toX),
      toY: unit.default(kb.toY),
    }),
  }),
  z.object({
    type: z.literal('zoom'),
    params: z.object({ scale: positive.default(zm.scale), x: unit.default(zm.x), y: unit.default(zm.y) }),
  }),
  z.object({
    type: z.literal('fade'),
    params: z.object({ in: time.default(EFFECT_DEFAULTS.fade.in), out: time.default(EFFECT_DEFAULTS.fade.out) }),
  }),
  z.object({ type: z.literal('xfade'), params: z.object({ duration: time.default(EFFECT_DEFAULTS.xfade.duration) }) }),
]);

const speed = z.number().finite().min(0.8).max(1.25);
const hold = z.number().finite().min(0);

const mediaClipSchema = z.object({
  id,
  assetId: id,
  start: time,
  duration: positive,
  in: time,
  sceneId: id.optional(),
  fit: z.enum(['cover', 'contain']),
  effects: z.array(effectSchema),
  /** Звук самого відео (0–2), коли він не винесений у зв'язаний аудіокліп. */
  volume: z.number().min(0).max(2).optional(),
  linkId: id.optional(),
  /** Темп відтворення джерела (0,8–1,25); лише в мовних версіях. */
  speed: speed.optional(),
  /** Секунди стоп-кадру в кінці кліпа. */
  hold: hold.optional(),
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
  linkId: id.optional(),
  speed: speed.optional(),
  /** Секунди тиші в кінці кліпа. */
  hold: hold.optional(),
  /** Кусково-лінійний множник гучності; `t` — секунди від початку кліпа. */
  envelope: z
    .array(z.object({ t: time, gain: z.number().finite().min(0).max(2) }))
    .superRefine((pts, ctx) => {
      for (let i = 1; i < pts.length; i++) {
        if (pts[i]!.t <= pts[i - 1]!.t) {
          ctx.addIssue({ code: 'custom', message: 'envelope.t має строго зростати', path: [i, 't'] });
        }
      }
    })
    .optional(),
});

const captionClipSchema = z.object({ id, audioClipId: id, transcriptId: id, styleId: id });

const trackSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('video'), clips: z.array(mediaClipSchema) }),
  z.object({
    id,
    kind: z.literal('audio'),
    clips: z.array(audioClipSchema),
    role: z.enum(['voiceover', 'music', 'sfx', 'original']),
    language: z.string().min(2).optional(),
  }),
  z.object({ id, kind: z.literal('captions'), clips: z.array(captionClipSchema), language: z.string().min(2) }),
]);

const segmentSchema = z.object({ id, start: time, end: time });
export type Segment = z.infer<typeof segmentSchema>;

const EPS = 1e-9;

export const timelineDocSchema = z
  .object({
    schemaVersion: z.literal(1),
    width: z.number().int().min(16).max(7680),
    height: z.number().int().min(16).max(7680),
    fps: z.number().int().min(1).max(120),
    tracks: z.array(trackSchema),
    /** Відрізки базового таймлайну для озвучки: впорядковані, без перекриттів, ≥ 1 кадр. */
    segments: z.array(segmentSchema).optional(),
  })
  .superRefine((doc, ctx) => {
    const segs = doc.segments ?? [];
    segs.forEach((s, i) => {
      if (s.end - s.start < 1 / doc.fps - EPS) {
        ctx.addIssue({ code: 'custom', message: 'Сегмент коротший за кадр', path: ['segments', i] });
      }
      if (i > 0 && s.start < segs[i - 1]!.end - EPS) {
        ctx.addIssue({
          code: 'custom',
          message: 'Сегменти мають бути впорядковані й не перекриватися',
          path: ['segments', i],
        });
      }
    });
  });

export type TimelineDoc = z.output<typeof timelineDocSchema>;
export type Track = z.infer<typeof trackSchema>;
export type MediaClip = z.infer<typeof mediaClipSchema>;
export type AudioClip = z.infer<typeof audioClipSchema>;
export type CaptionClip = z.infer<typeof captionClipSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type EffectType = Effect['type'];
export type AudioRole = Extract<Track, { kind: 'audio' }>['role'];

/** Документ із бази чи від клієнта → валідний повний `TimelineDoc` (замовчування ефектів заповнені). */
export function normalizeDoc(input: unknown): TimelineDoc {
  const r = timelineDocSchema.safeParse(input);
  if (!r.success) throw new AppError('VALIDATION', 'Невалідний таймлайн', { issues: r.error.issues });
  return r.data;
}

export const emptyTimeline = (format: VideoFormat, fps = 30): TimelineDoc => ({
  schemaVersion: 1,
  ...FORMATS[format],
  fps,
  tracks: [],
});
