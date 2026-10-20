import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
  type S3ClientConfig,
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
  /** Адреса для браузера: presigned URL підписуються на неї (підпис залежить від хоста) */
  publicEndpoint?: string;
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
const isNoSuchUpload = (e: unknown) =>
  status(e) === 404 || (e instanceof S3ServiceException && e.name === 'NoSuchUpload');

export function createS3BlobStorage(cfg: S3Config): BlobStorage {
  const clientConfig = (endpoint: string): S3ClientConfig => ({
    endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // інакше presigned PUT з браузера ламається на S3-сумісних сховищах (checksum-заголовки)
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
  });
  const client = new S3Client(clientConfig(cfg.endpoint));
  // лише для підпису URL (мережевих запитів не робить)
  const signer = cfg.publicEndpoint ? new S3Client(clientConfig(cfg.publicEndpoint)) : client;
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
      return getSignedUrl(signer, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), {
        expiresIn: expiresSec,
      });
    },

    presignGet(key, { expiresSec = 3600, downloadName } = {}) {
      const disposition = downloadName ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` : undefined;
      return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: disposition }), {
        expiresIn: expiresSec,
      });
    },

    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? 'application/octet-stream' };
      } catch (e) {
        if (status(e) === 404) return null;
        throw e;
      }
    },

    async createMultipart(key, { contentType }) {
      const res = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }));
      return res.UploadId!;
    },

    presignPart(key, uploadId, partNumber, { expiresSec = 3600 } = {}) {
      return getSignedUrl(
        signer,
        new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: expiresSec },
      );
    },

    async listParts(key, uploadId) {
      const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
      let marker: string | undefined;
      do {
        const res = await client.send(
          new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
        );
        for (const p of res.Parts ?? []) parts.push({ PartNumber: p.PartNumber!, ETag: p.ETag!, Size: p.Size ?? 0 });
        marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
      } while (marker);
      return parts;
    },

    async completeMultipart(key, uploadId, parts) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) },
        }),
      );
    },

    async abortMultipart(key, uploadId) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
      } catch (e) {
        if (!isNoSuchUpload(e)) throw e;
      }
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
