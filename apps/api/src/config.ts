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
  webOrigin: string;
  queueDriver: 'inprocess';
  aiFake: boolean;
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
    webOrigin: env.WEB_ORIGIN || 'http://localhost:5173',
    queueDriver: 'inprocess',
    aiFake: env.AI_FAKE === '1',
  };
}
