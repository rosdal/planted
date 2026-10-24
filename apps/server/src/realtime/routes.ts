import { monitorEventLoopDelay } from 'node:perf_hooks';
import { CloseCode } from '@planted/protocol';
import { ClearRoomResponse, PROTOCOL_VERSION, RoomId, RoomParams } from '@planted/schema';
import type { FastifyPluginAsync } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AuthDeps } from '../app';
import { requireRoomToken } from '../auth/bearer';
import { isLinkActive } from '../auth/links';
import { TokenError } from '../auth/room-token';
import { Connection } from './connection';
import type { RoomManager } from './room-manager';

/** The client must send `hello` this soon after the socket opens. */
export const HELLO_TIMEOUT_MS = 5000;

export type RealtimeDeps = AuthDeps & { manager: RoomManager };

/**
 * Handshake: socket opens → client sends `hello` within 5 s → token verified (signature,
 * expiry, room, link not revoked) → room loaded → `welcome` → sync-1 / sync-2. Any Yjs or
 * awareness frame before `welcome` closes the socket with 4400.
 */
export const realtimeRoutes: FastifyPluginAsyncZod<RealtimeDeps> = async (app, deps) => {
  const { db, tokens, manager } = deps;

  app.get<{ Params: { roomId: string } }>(
    '/rooms/:roomId/ws',
    { websocket: true },
    (socket, request) => {
      // Built and given a handler before any await, so no frame is missed.
      const conn = new Connection(socket, request.log);
      const parsed = RoomId.safeParse(request.params.roomId);
      if (!parsed.success) {
        conn.fail(CloseCode.RoomNotFound, 'room_not_found', 'No such room');
        return;
      }
      const roomId = parsed.data;
      let state: 'hello' | 'verifying' | 'done' = 'hello';
      const helloTimer = setTimeout(() => {
        if (state === 'hello') conn.fail(CloseCode.BadToken, 'hello_timeout', 'No hello');
      }, HELLO_TIMEOUT_MS);
      conn.onClose(() => clearTimeout(helloTimer));

      conn.setHandler((inbound) => {
        if (inbound.channel === 'frame') {
          conn.log.warn({ channel: inbound.frame.channel }, 'frame before welcome');
          conn.fail(CloseCode.BadFrame, 'not_welcomed', 'Send hello and wait for welcome');
          return;
        }
        const { message } = inbound;
        if (message.kind !== 'hello') return;
        if (state !== 'hello') {
          conn.fail(CloseCode.BadFrame, 'unexpected_hello', 'Only one hello per socket');
          return;
        }
        state = 'verifying';
        clearTimeout(helloTimer);
        void (async () => {
          const { protocol, token, clientName } = message.body;
          if (protocol < PROTOCOL_VERSION) {
            conn.fail(CloseCode.ProtocolTooOld, 'upgrade', 'Reload to update', message.seq);
            return;
          }
          if (protocol > PROTOCOL_VERSION) {
            conn.fail(
              CloseCode.BadFrame,
              'unsupported_protocol',
              `Server speaks protocol ${PROTOCOL_VERSION}`,
              message.seq,
            );
            return;
          }
          let claims: Awaited<ReturnType<typeof tokens.verify>>;
          try {
            claims = await tokens.verify(token);
          } catch (err) {
            if (!(err instanceof TokenError)) throw err;
            conn.fail(CloseCode.BadToken, 'bad_token', 'Invalid or expired token', message.seq);
            return;
          }
          if (claims.roomId !== roomId) {
            conn.fail(CloseCode.BadToken, 'bad_token', 'Token is for another room', message.seq);
            return;
          }
          // A rotated link's tokens are refused even while they're still unexpired.
          if (!(await isLinkActive(db, roomId, claims.lid))) {
            conn.fail(CloseCode.BadToken, 'link_revoked', 'This link was revoked', message.seq);
            return;
          }
          const room = await manager.getOrCreate(roomId);
          if (!room) {
            conn.fail(CloseCode.RoomNotFound, 'room_not_found', 'No such room', message.seq);
            return;
          }
          if (!conn.isOpen) return;
          state = 'done';
          conn.log.info({ roomId, clientName, role: claims.role }, 'conn.hello');
          room.join(conn, claims.role, message.seq);
        })().catch((err: unknown) => {
          conn.log.error({ err }, 'handshake failed');
          conn.fail(CloseCode.Internal, 'internal', 'Server error');
        });
      });
    },
  );

  app.post(
    '/rooms/:roomId/clear',
    { schema: { params: RoomParams, response: { 200: ClearRoomResponse } } },
    async (request) => {
      const { roomId } = request.params;
      await requireRoomToken(request, deps, roomId, 'edit');
      const roomEpoch = await manager.clear(roomId);
      return { roomEpoch };
    },
  );
};

/**
 * Dev-only snapshot of what is in memory, plus process RSS and cumulative CPU time so the bot
 * script can report server load. Never registered in production.
 */
export const realtimeDebugRoutes: FastifyPluginAsync<{ manager: RoomManager }> = async (
  app,
  { manager },
) => {
  // Event-loop delay since the previous request: the server-side queueing the bots can't see.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  app.addHook('onClose', async () => loopDelay.disable());
  app.get('/debug/realtime', async () => {
    const { user, system } = process.cpuUsage();
    const loopP99Ms = loopDelay.percentile(99) / 1e6;
    loopDelay.reset();
    return {
      ...manager.stats(),
      process: { rssBytes: process.memoryUsage.rss(), cpuMicros: user + system, loopP99Ms },
    };
  });
};
