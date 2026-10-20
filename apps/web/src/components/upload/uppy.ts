import AwsS3 from '@uppy/aws-s3';
import Uppy, { type Meta } from '@uppy/core';
import { MULTIPART_THRESHOLD, PART_SIZE } from '@vf/shared';
import type { trpcClient } from '@/lib/trpc';

export interface UploadMeta extends Meta {
  assetId?: string;
  mode?: 'single' | 'multipart';
}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type VfUppy = Uppy<UploadMeta, {}>;

/**
 * Uppy без UI: S3-ключ, multipart і підтвердження веде сервер (assets.*), Uppy — лише передачу байтів,
 * паралельність і повтори частин. key у колбеках = assetId.
 */
export function createUppy(client: typeof trpcClient): VfUppy {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  const uppy = new Uppy<UploadMeta, {}>({ autoProceed: true });

  const ticket = async (file: { id: string; name?: string; type: string; size: number | null }) => {
    const t = await client.assets.createUpload.mutate({
      name: file.name ?? 'file',
      mime: file.type,
      size: file.size ?? 0,
    });
    uppy.setFileMeta(file.id, { assetId: t.assetId, mode: t.mode });
    return t;
  };

  uppy.use(AwsS3, {
    limit: 4,
    retryDelays: [0, 1000, 3000, 5000, 10000],
    shouldUseMultipart: (file) => (file.size ?? 0) >= MULTIPART_THRESHOLD,
    getChunkSize: () => PART_SIZE,
    async getUploadParameters(file) {
      // повтор після помилки: той самий asset, новий URL (а не ще один рядок у бібліотеці)
      const existing = file.meta.assetId as string | undefined;
      if (existing && file.meta.mode === 'single') {
        const again = await client.assets.resignPut.mutate({ assetId: existing });
        return { method: 'PUT', url: again.url, headers: { 'content-type': again.mime } };
      }
      const t = await ticket(file);
      if (t.mode !== 'single') throw new Error('Очікувалось одиночне завантаження');
      return { method: 'PUT', url: t.url, headers: { 'content-type': t.mime } };
    },
    async createMultipartUpload(file) {
      const t = await ticket(file);
      if (t.mode !== 'multipart') throw new Error('Очікувалось multipart-завантаження');
      return { uploadId: t.uploadId, key: t.assetId };
    },
    async signPart(_file, { key, partNumber }) {
      const [part] = await client.assets.signParts.mutate({ assetId: key, partNumbers: [partNumber] });
      return { method: 'PUT', url: part!.url };
    },
    async listParts(_file, { key }) {
      return client.assets.listParts.query({ assetId: key });
    },
    async completeMultipartUpload(_file, { key, parts }) {
      await client.assets.complete.mutate({
        assetId: key,
        parts: parts.map((p) => ({ PartNumber: p.PartNumber!, ETag: p.ETag! })),
      });
      return {};
    },
    async abortMultipartUpload(_file, { key }) {
      await client.assets.abort.mutate({ assetId: key });
    },
  });
  return uppy;
}
