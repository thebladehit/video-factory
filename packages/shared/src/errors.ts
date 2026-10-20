export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'INVALID_PAYLOAD'
  | 'UNKNOWN_JOB_TYPE'
  | 'CONFLICT'
  | 'INFRA_UNAVAILABLE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
