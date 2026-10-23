import { monitorEventLoopDelay } from 'node:perf_hooks';
import { rooms } from '@planted/db';
import { RoomId } from '@planted/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app';
import { CloseCode, Connection } from './connection';
import type { RoomManager } from './room-manager';

export type RealtimeDeps = AppDeps & { manager: RoomManager };

export const realtimeRoutes: FastifyPluginAsync<RealtimeDeps> = async (app, { db, manager }) => {
  app.get<{ Params: { roomId: string } }>(
    '/rooms/:roomId/ws',
    { websocket: true },
    async (socket, request) => {
      // Built before the first await so frames sent straight after open are queued, not lost.
      const conn = new Connection(socket, request.log);
      const parsed = RoomId.safeParse(request.params.roomId);
      let found = false;
      if (parsed.success) {
        try {
          const rows = await db
            .select({ id: rooms.id })
            .from(rooms)
            .where(eq(rooms.id, parsed.data));
          found = rows.length > 0;
        } catch (err) {
          request.log.error({ err }, 'room lookup failed');
          conn.close(CloseCode.Internal, 'internal');
          return;
        }
      }
      if (!parsed.success || !found) {
        conn.close(CloseCode.RoomNotFound, 'room_not_found');
        return;
      }
      if (!conn.isOpen) return;
      manager.getOrCreate(parsed.data).join(conn);
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
