import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { Db } from '@planted/db';
import { MAX_SYNC_FRAME_BYTES } from '@planted/protocol';
import Fastify, { type FastifyServerOptions } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Env } from './env';
import { AppError, errorHandler, notFoundHandler } from './errors';
import { RoomManager } from './realtime/room-manager';
import { realtimeDebugRoutes, realtimeRoutes } from './realtime/routes';
import { healthRoutes } from './routes/health';
import { roomRoutes } from './routes/rooms';

export type AppDeps = { db: Db };

declare module 'fastify' {
  interface FastifyInstance {
    realtime: RoomManager;
  }
}

export type BuildAppOptions = AppDeps & {
  env: Pick<Env, 'NODE_ENV' | 'WEB_ORIGIN' | 'LOG_LEVEL'>;
};

// Fastify's default serializers log method, url and status code, never bodies; keep it that way.
function loggerOptions(env: BuildAppOptions['env']): NonNullable<FastifyServerOptions['logger']> {
  if (env.NODE_ENV === 'test') return false;
  if (env.NODE_ENV === 'development') {
    return {
      level: env.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname', singleLine: true },
      },
    };
  }
  return { level: env.LOG_LEVEL };
}

/** Pure app factory: no env reads, no listening. Tests drive it with `app.inject`. */
export async function buildApp({ db, env }: BuildAppOptions) {
  const app = Fastify({
    logger: loggerOptions(env),
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(helmet);
  await app.register(cors, { origin: env.WEB_ORIGIN, methods: ['GET', 'POST'] });
  // Limits are per route (see POST /rooms). The store is in-memory, which is fine for one process.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      new AppError('rate_limited', 429, `Too many requests, retry in ${context.after}`),
  });

  await app.register(healthRoutes, { db });
  await app.register(roomRoutes, { db });

  const manager = new RoomManager(app.log);
  app.decorate('realtime', manager);
  // Added before the websocket plugin's own preClose, so clients get 1001 going_away (and
  // reconnect) rather than a bare close.
  app.addHook('preClose', async () => manager.closeAll());
  await app.register(websocket, { options: { maxPayload: MAX_SYNC_FRAME_BYTES } });
  await app.register(realtimeRoutes, { db, manager });
  if (env.NODE_ENV !== 'production') await app.register(realtimeDebugRoutes, { manager });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
