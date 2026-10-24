import { RoomParams, RoomTokenRequest, RoomTokenResponse } from '@planted/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AuthDeps } from '../app';
import { findLinkByKey } from '../auth/links';
import { AppError } from '../errors';

export const tokenRoutes: FastifyPluginAsyncZod<AuthDeps> = async (app, { db, tokens }) => {
  app.post(
    '/rooms/:roomId/token',
    {
      // The only thing between a guessed key and a token: strictest limit in the app.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: RoomParams,
        body: RoomTokenRequest,
        response: { 200: RoomTokenResponse },
      },
    },
    async (request) => {
      const { roomId } = request.params;
      const link = await findLinkByKey(db, roomId, request.body.key);
      // One answer for a missing room, a revoked link and a wrong key (ADR 0005).
      if (!link) throw new AppError('forbidden', 403, 'This link is not valid');
      const { token, expiresAt } = await tokens.sign({ roomId, role: link.role, lid: link.id });
      return { token, role: link.role, expiresAt: expiresAt.toISOString() };
    },
  );
};
