import { AppError } from '@vf/shared';
import type { S3Config } from '@vf/storage';

export interface AppConfig {
  databaseUrl: string;
  s3: S3Config;
  apiPort: number;
  /** У контейнері — 0.0.0.0, локально — 127.0.0.1 */
  apiHost: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** Вбудовані шрифти субтитрів (`fontsdir` фільтра `subtitles`) */
  captionsFontsDir: string;
  /** Опитування провайдера під час генерації відео */
  videoPollMs: number;
  videoTimeoutMs: number;
  webOrigin: string;
  queueDriver: 'inprocess';
  aiFake: boolean;
  /** OAuth-клієнт Google; без id/secret підключення YouTube вимкнене */
  youtube: { clientId?: string; clientSecret?: string; audited: boolean };
  /** TOKEN_ENCRYPTION_KEY (32 байти): шифрування токенів і підпис OAuth state */
  tokenKey?: Buffer;
  /** Fake OAuth/публікатор замість YouTube (e2e, розробка без Google) */
  publishFake: boolean;
  /** Період тіку публікацій (e2e — коротший, щоб не чекати хвилину) */
  publishTickMs: number;
}

const REQUIRED = ['DATABASE_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'] as const;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const missing = REQUIRED.filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new AppError(
      'VALIDATION',
      `Не задано змінні середовища: ${missing.join(', ')}. Скопіюйте .env.example у .env`,
      {
        missing,
      },
    );
  }
  if (env.QUEUE_DRIVER && env.QUEUE_DRIVER !== 'inprocess') {
    throw new AppError('VALIDATION', `QUEUE_DRIVER=${env.QUEUE_DRIVER} ще не підтримується (доступно: inprocess)`);
  }
  const clientId = env.YOUTUBE_CLIENT_ID?.trim() || undefined;
  const tokenKey = parseTokenKey(env.TOKEN_ENCRYPTION_KEY);
  if (clientId && !tokenKey) {
    throw new AppError(
      'VALIDATION',
      'Задано YOUTUBE_CLIENT_ID, але TOKEN_ENCRYPTION_KEY відсутній або некоректний (потрібно 32 байти в base64: openssl rand -base64 32)',
    );
  }
  return {
    databaseUrl: env.DATABASE_URL!,
    s3: {
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION || 'us-east-1',
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      bucket: env.S3_BUCKET!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
      // адреса S3 для браузера (у Docker відрізняється від S3_ENDPOINT)
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || undefined,
    },
    apiPort: Number(env.API_PORT || 3001),
    apiHost: env.API_HOST || '127.0.0.1',
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    captionsFontsDir: env.CAPTIONS_FONTS_DIR || '/app/packages/captions/fonts',
    videoPollMs: 10_000,
    videoTimeoutMs: 15 * 60_000,
    webOrigin: env.WEB_ORIGIN || 'http://localhost:5173',
    queueDriver: 'inprocess',
    aiFake: env.AI_FAKE === '1',
    youtube: {
      clientId,
      clientSecret: env.YOUTUBE_CLIENT_SECRET?.trim() || undefined,
      audited: env.YOUTUBE_API_AUDITED === '1',
    },
    tokenKey,
    publishFake: env.PUBLISH_FAKE === '1',
    publishTickMs: Number(env.PUBLISH_TICK_MS) || 60_000,
  };
}

/** base64 → рівно 32 байти, інакше undefined (саме значення ключа в помилки не потрапляє) */
function parseTokenKey(raw: string | undefined): Buffer | undefined {
  const v = raw?.trim();
  if (!v || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return undefined;
  const key = Buffer.from(v, 'base64');
  return key.length === 32 ? key : undefined;
}
