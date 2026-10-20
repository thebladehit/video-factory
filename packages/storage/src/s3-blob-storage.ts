import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '@vf/shared';
import type { BlobStorage } from './blob-storage';

export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv): S3Config {
  return {
    endpoint: env.S3_ENDPOINT ?? '',
    region: env.S3_REGION ?? 'us-east-1',
    accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    bucket: env.S3_BUCKET ?? '',
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
  };
}

const status = (e: unknown) => (e instanceof S3ServiceException ? e.$metadata.httpStatusCode : undefined);

export function createS3BlobStorage(cfg: S3Config): BlobStorage {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // інакше presigned PUT з браузера ламається на S3-сумісних сховищах (checksum-заголовки)
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
  });
  const Bucket = cfg.bucket;

  return {
    async put(key, body, { contentType }) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return {
          body: res.Body as Readable,
          contentType: res.ContentType ?? 'application/octet-stream',
          size: res.ContentLength ?? 0,
        };
      } catch (e) {
        if (status(e) === 404) throw new AppError('NOT_FOUND', `Файл не знайдено: ${key}`, { key });
        throw e;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    presignPut(key, { contentType, expiresSec = 900 }) {
      return getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), {
        expiresIn: expiresSec,
      });
    },

    presignGet(key, { expiresSec = 3600 } = {}) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: expiresSec });
    },

    async ensureBucket({ corsOrigins } = {}) {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch (e) {
        if (status(e) !== 404) throw e;
        await client.send(new CreateBucketCommand({ Bucket }));
      }
      if (corsOrigins?.length) {
        await client.send(
          new PutBucketCorsCommand({
            Bucket,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedOrigins: corsOrigins,
                  AllowedMethods: ['PUT', 'GET', 'HEAD'],
                  AllowedHeaders: ['*'],
                  ExposeHeaders: ['ETag'],
                  MaxAgeSeconds: 3600,
                },
              ],
            },
          }),
        );
      }
    },

    async ping() {
      await client.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(2000) });
    },
  };
}
