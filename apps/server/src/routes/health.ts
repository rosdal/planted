import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../app';

const HealthResponse = z.object({ ok: z.boolean(), db: z.enum(['up', 'down']) });

export const healthRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { db }) => {
  app.get(
    '/health',
    { schema: { response: { 200: HealthResponse, 503: HealthResponse } } },
    async (request, reply) => {
      try {
        await db.execute(sql`select 1`);
        return { ok: true, db: 'up' as const };
      } catch (err) {
        request.log.warn({ err }, 'health check: database unreachable');
        return reply.status(503).send({ ok: false, db: 'down' });
      }
    },
  );
};
