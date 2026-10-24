import { CloseCode } from '@planted/protocol';
import { RoomParams, RotateLinksResponse } from '@planted/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AuthDeps } from '../app';
import { requireRoomToken } from '../auth/bearer';
import { rotateLinks } from '../auth/links';
import type { RoomManager } from '../realtime/room-manager';

export const linkRoutes: FastifyPluginAsyncZod<AuthDeps & { manager: RoomManager }> = async (
  app,
  deps,
) => {
  app.post(
    '/rooms/:roomId/links/rotate',
    { schema: { params: RoomParams, response: { 200: RotateLinksResponse } } },
    async (request) => {
      const { roomId } = request.params;
      await requireRoomToken(request, deps, roomId, 'edit');
      const keys = await rotateLinks(deps.db, roomId);
      // Everyone drops out, the caller included; holders of the new links get straight back in,
      // since the client refetches a token on 4401 and old tokens fail the `lid` check.
      deps.manager.disconnectAll(roomId, CloseCode.BadToken, 'links_rotated');
      request.log.info({ roomId }, 'room.links_rotated');
      return keys;
    },
  );
};
