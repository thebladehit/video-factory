import type { FastifyInstance } from 'fastify';
import { isAppError } from '@vf/shared';
import type { AppDeps } from '../../app';
import { completeOAuth } from './accounts';

type ConnectError = 'denied' | 'state' | 'exchange';

/**
 * `GET /oauth/youtube/callback` — сюди Google повертає після згоди (через Vite-проксі `/oauth`).
 * Завжди 302 на `/publications` з `connected=<id>` або `connectError=<код>`.
 */
export function registerOAuthRoutes(server: FastifyInstance, deps: AppDeps) {
  server.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/oauth/youtube/callback',
    async (req, reply) => {
      const back = (q: string) => reply.redirect(`${deps.publish.redirectBase}/publications?${q}`, 302);
      const fail = (code: ConnectError) => back(`connectError=${code}`);
      const { code, state, error } = req.query;
      if (error) return fail('denied');
      if (!code || !state) return fail('state');
      try {
        const { userId } = await deps.auth.authenticate(req);
        const id = await completeOAuth(deps, { code, state, userId });
        return back(`connected=${encodeURIComponent(id)}`);
      } catch (e) {
        if (isAppError(e) && e.code === 'VALIDATION') return fail('state');
        // лише код і текст помилки — ні code, ні токенів у журналі
        deps.log.error(
          { err: { message: (e as Error).message, code: isAppError(e) ? e.code : undefined } },
          'Підключення YouTube не вдалося',
        );
        return fail('exchange');
      }
    },
  );
}
