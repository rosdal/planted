import type { Db } from '@planted/db';
import type { RoomId } from '@planted/schema';
import type { FastifyBaseLogger } from 'fastify';

/** Any constant both instances agree on; it names this job in `pg_locks`. */
export const EXPIRE_ROOMS_LOCK = 4_040_001;
export const EXPIRE_AFTER_DAYS = 30;
export const EXPIRE_BATCH = 500;

export type ExpireResult = { deleted: number; ms: number; skipped: boolean };

/**
 * Deletes guest rooms idle for 30 days, 500 at a time; the cascade removes their docs and links.
 * Rooms loaded in memory are skipped even if their `last_active_at` is old, since they may be
 * about to save. A session advisory lock on one reserved connection means two server instances
 * never run it at once; the second just skips.
 */
export async function expireRooms(
  db: Db,
  loadedRoomIds: () => RoomId[],
  log: FastifyBaseLogger,
): Promise<ExpireResult> {
  const start = performance.now();
  const sql = await db.$client.reserve();
  try {
    const [lock] = await sql<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${EXPIRE_ROOMS_LOCK}) as locked`;
    if (!lock?.locked) {
      log.info('jobs.expire_rooms skipped: another instance holds the lock');
      return { deleted: 0, ms: Math.round(performance.now() - start), skipped: true };
    }
    let deleted = 0;
    try {
      for (;;) {
        const loaded = loadedRoomIds();
        // TODO(0.8): exclude rooms that belong to a team strat; only guest rooms expire.
        const rows = await sql`
          delete from rooms
          where id in (
            select id from rooms
            where last_active_at < now() - make_interval(days => ${EXPIRE_AFTER_DAYS})
              and not (id = any(${loaded}::text[]))
            limit ${EXPIRE_BATCH}
          )
          returning id`;
        deleted += rows.length;
        if (rows.length < EXPIRE_BATCH) break;
      }
    } finally {
      await sql`select pg_advisory_unlock(${EXPIRE_ROOMS_LOCK})`;
    }
    const ms = Math.round(performance.now() - start);
    log.info({ deleted, ms }, 'jobs.expire_rooms');
    return { deleted, ms, skipped: false };
  } finally {
    sql.release();
  }
}
