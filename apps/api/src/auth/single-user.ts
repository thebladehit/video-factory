import type { FastifyRequest } from 'fastify';
import { LOCAL_USER_ID } from '@vf/shared';

export interface AuthProvider {
  authenticate(req: FastifyRequest): Promise<{ userId: string }>;
}

/** v1: один локальний користувач. Пізніше — Better Auth / Clerk за тим самим інтерфейсом. */
export const singleUserAuth: AuthProvider = {
  authenticate: async () => ({ userId: LOCAL_USER_ID }),
};
