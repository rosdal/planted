import { initialDocState } from '@planted/client';
import { CONTENT_VERSION, MAP_IDS } from '@planted/content';
import { roomDocs, rooms } from '@planted/db';
import {
  CreateRoomRequest,
  CreateRoomResponse,
  GetRoomResponse,
  RoomParams,
} from '@planted/schema';
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
      schema: { body: CreateRoomRequest, response: { 201: CreateRoomResponse } },
    },
    async (request, reply) => {
      const { mapId } = request.body;
      if (!MAP_IDS.includes(mapId)) {
        throw new AppError('bad_request', 400, `Unknown map ${JSON.stringify(mapId)}`);
      }
      const roomId = newRoomId();
      const contentVersion = CONTENT_VERSION;
      // One transaction: a room is never visible without its links and its initial doc.
      const created = await db.transaction(async (tx) => {
        const [room] = await tx
          .insert(rooms)
          .values({ id: roomId, mapId, contentVersion })
          .returning({ createdAt: rooms.createdAt });
        if (!room) throw new Error('insert into rooms returned no row');
        const createdAt = room.createdAt.toISOString();
        await tx.insert(roomDocs).values({
          roomId,
          ydoc: initialDocState({ mapId, contentVersion, createdAt }),
          version: 1,
        });
        return { createdAt, ...(await createLinks(tx, roomId)) };
      });
      return reply.status(201).send({
        roomId,
        createdAt: created.createdAt,
        mapId,
        contentVersion,
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
        .select({
          createdAt: rooms.createdAt,
          mapId: rooms.mapId,
          contentVersion: rooms.contentVersion,
        })
        .from(rooms)
        .where(eq(rooms.id, roomId));
      if (!room) throw new AppError('not_found', 404, 'Room not found');
      return {
        roomId,
        createdAt: room.createdAt.toISOString(),
        mapId: room.mapId,
        contentVersion: room.contentVersion,
      };
    },
  );
};
