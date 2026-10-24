import type { Readable } from 'node:stream';
import type { Platform, PublicationMeta } from '@vf/shared';

/** Сигнатура як у глобального fetch — адаптери ходять у мережу лише через неї */
export type FetchFn = typeof globalThis.fetch;

export interface UploadFile {
  size: number;
  contentType: string;
  /** Потік від байта fromByte до кінця файлу (fromByte < size) */
  open(fromByte: number): Promise<Readable>;
}

/** Свіжий access token (сервіс сам оновлює його, коли той спливає) */
export type AccessTokenSource = () => Promise<string>;

export type VideoFormat = '9:16' | '16:9';

export interface UploadRequest {
  tokens: AccessTokenSource;
  file: UploadFile;
  meta: PublicationMeta;
  language: string;
  /** Для URL: Shorts для 9:16 */
  format: VideoFormat;
  publishAt?: Date;
  /** Збережений URI сесії — продовжити замість нового завантаження */
  resume?: string;
  /** Зберегти URI до початку передачі байтів */
  onSession(uri: string): Promise<void>;
  onProgress(pct: number): Promise<void>;
  signal: AbortSignal;
}

export interface PublishStatus {
  state: 'processing' | 'ready' | 'failed';
  error?: string;
}

export interface Publisher {
  platform: Platform;
  /** Завантаження з продовженням: resume — збережений URI сесії */
  upload(req: UploadRequest): Promise<{ platformPostId: string; url: string }>;
  status(tokens: AccessTokenSource, platformPostId: string): Promise<PublishStatus>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
}

export interface OAuthAccount {
  externalId: string;
  name: string;
  profileUrl: string;
}

export interface OAuthProvider {
  authUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<OAuthTokens & { account: OAuthAccount }>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}

export type PublishErrorReason = 'quota' | 'auth' | 'rejected' | 'transient' | 'other';

export class PublishError extends Error {
  readonly reason: PublishErrorReason;
  /** Сирий код причини від платформи (наприклад, error.errors[0].reason у YouTube) */
  readonly platformReason?: string;

  constructor(reason: PublishErrorReason, message: string, platformReason?: string) {
    super(message);
    this.name = 'PublishError';
    this.reason = reason;
    this.platformReason = platformReason;
  }
}
