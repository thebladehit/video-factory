import type { Readable } from 'node:stream';

export interface BlobStorage {
  put(key: string, body: Uint8Array | Readable, opts: { contentType: string }): Promise<void>;
  /** Немає ключа → AppError('NOT_FOUND') */
  get(key: string): Promise<{ body: Readable; contentType: string; size: number }>;
  /** Ідемпотентно */
  delete(key: string): Promise<void>;
  presignPut(key: string, opts: { contentType: string; expiresSec?: number }): Promise<string>;
  presignGet(key: string, opts?: { expiresSec?: number }): Promise<string>;
  /** Створює бакет, якщо його нема, і налаштовує CORS для прямих завантажень з браузера */
  ensureBucket(opts?: { corsOrigins?: string[] }): Promise<void>;
  /** Перевірка доступності (таймаут 2 с) */
  ping(): Promise<void>;
}
