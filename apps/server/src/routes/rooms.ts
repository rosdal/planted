import { rooms } from '@planted/db';
import { CreateRoomResponse, GetRoomParams, GetRoomResponse } from '@planted/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../app';
import { AppError } from '../errors';
import { newRoomId } from '../ids';

export const roomRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { db }) => {
  app.post(
    '/rooms',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { response: { 201: CreateRoomResponse } },
    },
    async (_request, reply) => {
      const roomId = newRoomId();
      const [room] = await db
        .insert(rooms)
        .values({ id: roomId })
        .returning({ createdAt: rooms.createdAt });
      if (!room) throw new Error('insert into rooms returned no row');
      return reply.status(201).send({ roomId, createdAt: room.createdAt.toISOString() });
    },
  );

  app.get(
    '/rooms/:roomId',
    { schema: { params: GetRoomParams, response: { 200: GetRoomResponse } } },
    async (request) => {
      const { roomId } = request.params;
      const [room] = await db
        .select({ createdAt: rooms.createdAt, mapId: rooms.mapId })
        .from(rooms)
        .where(eq(rooms.id, roomId));
      if (!room) throw new AppError('not_found', 404, 'Room not found');
      return { roomId, createdAt: room.createdAt.toISOString(), mapId: room.mapId };
    },
  );
};
