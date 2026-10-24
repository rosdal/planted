import { rooms } from '@planted/db';
import { CreateRoomResponse, GetRoomResponse, RoomParams } from '@planted/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AuthDeps } from '../app';
import { requireRoomToken } from '../auth/bearer';
import { createLinks } from '../auth/links';
import { AppError } from '../errors';
import { newRoomId } from '../ids';

export const roomRoutes: FastifyPluginAsyncZod<AuthDeps> = async (app, deps) => {
  const { db } = deps;

  app.post(
    '/rooms',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { response: { 201: CreateRoomResponse } },
    },
    async (_request, reply) => {
      const roomId = newRoomId();
      const created = await db.transaction(async (tx) => {
        const [room] = await tx
          .insert(rooms)
          .values({ id: roomId })
          .returning({ createdAt: rooms.createdAt });
        if (!room) throw new Error('insert into rooms returned no row');
        return { createdAt: room.createdAt, ...(await createLinks(tx, roomId)) };
      });
      return reply.status(201).send({
        roomId,
        createdAt: created.createdAt.toISOString(),
        editKey: created.editKey,
        viewKey: created.viewKey,
      });
    },
  );

  app.get(
    '/rooms/:roomId',
    { schema: { params: RoomParams, response: { 200: GetRoomResponse } } },
    async (request) => {
      const { roomId } = request.params;
      await requireRoomToken(request, deps, roomId);
      const [room] = await db
        .select({ createdAt: rooms.createdAt, mapId: rooms.mapId })
        .from(rooms)
        .where(eq(rooms.id, roomId));
      if (!room) throw new AppError('not_found', 404, 'Room not found');
      return { roomId, createdAt: room.createdAt.toISOString(), mapId: room.mapId };
    },
  );
};
