import type { Readable } from 'node:stream';

export interface BlobStorage {
  put(key: string, body: Uint8Array | Readable, opts: { contentType: string }): Promise<void>;
  /** Немає ключа → AppError('NOT_FOUND') */
  get(key: string): Promise<{ body: Readable; contentType: string; size: number }>;
  /** Ідемпотентно */
  delete(key: string): Promise<void>;
  presignPut(key: string, opts: { contentType: string; expiresSec?: number }): Promise<string>;
  presignGet(key: string, opts?: { expiresSec?: number }): Promise<string>;
  /** Розмір і тип об'єкта; null — немає */
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  /** Multipart-завантаження великих файлів напряму з браузера; повертає uploadId */
  createMultipart(key: string, opts: { contentType: string }): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, opts?: { expiresSec?: number }): Promise<string>;
  listParts(key: string, uploadId: string): Promise<{ PartNumber: number; ETag: string; Size: number }[]>;
  completeMultipart(key: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]): Promise<void>;
  /** Ідемпотентно (зокрема для неіснуючого uploadId) */
  abortMultipart(key: string, uploadId: string): Promise<void>;
  /** Створює бакет, якщо його нема, і налаштовує CORS для прямих завантажень з браузера */
  ensureBucket(opts?: { corsOrigins?: string[] }): Promise<void>;
  /** Перевірка доступності (таймаут 2 с) */
  ping(): Promise<void>;
}
