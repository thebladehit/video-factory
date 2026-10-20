import { AppError } from './errors';

export type AssetKind = 'image' | 'video' | 'audio';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export const MEDIA_LIMITS: Record<AssetKind, { mimes: readonly string[]; maxBytes: number }> = {
  image: { mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], maxBytes: 50 * MB },
  video: { mimes: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 5 * GB },
  audio: {
    mimes: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/ogg'],
    maxBytes: 500 * MB,
  },
};

/** Файли від 64 МБ вантажаться частинами по 16 МБ */
export const MULTIPART_THRESHOLD = 64 * MB;
export const PART_SIZE = 16 * MB;

const BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};
const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
};

const extOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export function kindForMime(mime: string): AssetKind | null {
  for (const [kind, { mimes }] of Object.entries(MEDIA_LIMITS)) if (mimes.includes(mime)) return kind as AssetKind;
  return null;
}

export function mimeFromName(name: string): string | null {
  return BY_EXT[extOf(name)] ?? null;
}

const formatSize = (bytes: number) => (bytes >= GB ? `${bytes / GB} ГБ` : `${bytes / MB} МБ`);

/** Перевірка перед завантаженням: тип (MIME або розширення) і розмір. */
export function validateUpload(i: { name: string; mime: string; size: number }): {
  kind: AssetKind;
  mime: string;
  ext: string;
} {
  const mime = (i.mime || mimeFromName(i.name) || '').toLowerCase();
  const kind = kindForMime(mime);
  if (!kind) {
    throw new AppError('VALIDATION', `Непідтримуваний тип файлу «${i.name}». Підтримуються фото, відео й аудіо`, {
      name: i.name,
      mime: i.mime,
    });
  }
  if (!(i.size > 0)) throw new AppError('VALIDATION', `Файл «${i.name}» порожній`, { name: i.name });
  const { maxBytes } = MEDIA_LIMITS[kind];
  if (i.size > maxBytes) {
    throw new AppError('VALIDATION', `Файл «${i.name}» завеликий: максимум ${formatSize(maxBytes)}`, {
      name: i.name,
      size: i.size,
      maxBytes,
    });
  }
  return { kind, mime, ext: EXT_FOR_MIME[mime]! };
}
