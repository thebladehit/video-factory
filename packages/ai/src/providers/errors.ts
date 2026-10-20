import { APICallError } from 'ai';
import { AppError, isAppError, type ProviderId } from '@vf/shared';

/** Будь-яка помилка провайдера → PROVIDER_ERROR з його текстом (напр. «401 invalid x-api-key»). */
export function toProviderError(provider: ProviderId, e: unknown): AppError {
  if (isAppError(e)) return e;
  // AI SDK обгортає ретраї в RetryError з lastError
  const last = (e as { lastError?: unknown })?.lastError ?? e;
  const status = APICallError.isInstance(last) ? last.statusCode : undefined;
  const message = last instanceof Error ? last.message : String(last);
  return new AppError('PROVIDER_ERROR', `${provider}: ${message}`, { provider, status });
}
