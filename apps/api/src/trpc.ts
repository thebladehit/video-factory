import { initTRPC, TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { isAppError, type ErrorCode } from '@vf/shared';
import type { AppDeps } from './app';

export interface Context {
  userId: string;
  deps: AppDeps;
}

const CODE_MAP: Record<ErrorCode, TRPC_ERROR_CODE_KEY> = {
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'BAD_REQUEST',
  MODEL_NOT_FOUND: 'BAD_REQUEST',
  MODEL_UNAVAILABLE: 'BAD_REQUEST',
  INVALID_PAYLOAD: 'BAD_REQUEST',
  UNKNOWN_JOB_TYPE: 'BAD_REQUEST',
  CONFLICT: 'CONFLICT',
  PROVIDER_ERROR: 'BAD_GATEWAY',
  INFRA_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL: 'INTERNAL_SERVER_ERROR',
};

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const cause = isAppError(error.cause) ? error.cause : null;
    // stack trace клієнту не віддаємо
    const data: Partial<typeof shape.data> = { ...shape.data };
    delete data.stack;
    return { ...shape, data: { ...data, appCode: cause?.code ?? null, details: cause?.details ?? null } };
  },
});

/** AppError → TRPCError з відповідним HTTP-кодом; сам AppError лишається в cause. */
const appErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && isAppError(result.error.cause)) {
    const cause = result.error.cause;
    throw new TRPCError({ code: CODE_MAP[cause.code], message: cause.message, cause });
  }
  return result;
});

export const router = t.router;
export const procedure = t.procedure.use(appErrors);
