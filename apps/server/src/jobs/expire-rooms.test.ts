import { roomLinks, rooms } from '@planted/db';
import type { RoomId } from '@planted/schema';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers';
import { createRoom } from '../test/realtime';
import { EXPIRE_ROOMS_LOCK, expireRooms } from './expire-rooms';
import { msUntilNextHour } from './scheduler';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

async function idleFor(roomId: string, days: number): Promise<void> {
  await t.db
    .update(rooms)
    .set({ lastActiveAt: sql`now() - make_interval(days => ${days})` })
    .where(eq(rooms.id, roomId));
}

async function exists(roomId: string): Promise<boolean> {
  return (await t.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId))).length > 0;
}

describe('expireRooms', () => {
  it('deletes rooms idle 31 days with their links, keeps 29 days, and keeps a loaded room', async () => {
    const [old, recent, loaded] = await Promise.all([1, 2, 3].map(() => createRoom(t.app)));
    if (!old || !recent || !loaded) throw new Error('rooms not created');
    await idleFor(old.roomId, 31);
    await idleFor(recent.roomId, 29);
    await idleFor(loaded.roomId, 31);

    const result = await expireRooms(t.db, () => [loaded.roomId as RoomId], t.app.log);
    expect(result).toMatchObject({ deleted: 1, skipped: false });
    expect(await exists(old.roomId)).toBe(false);
    expect(await exists(recent.roomId)).toBe(true);
    expect(await exists(loaded.roomId)).toBe(true);
    const links = await t.db.select().from(roomLinks).where(eq(roomLinks.roomId, old.roomId));
    expect(links).toEqual([]);
  });

  it('deletes in batches until nothing old is left', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `batch${String(i).padStart(17, '0')}`);
    await t.db.insert(rooms).values(ids.map((id) => ({ id })));
    await t.db.execute(sql`update rooms set last_active_at = now() - interval '40 days'`);
    const result = await expireRooms(t.db, () => [], t.app.log);
    expect(result.deleted).toBe(1201);
  });

  it('skips when another instance holds the lock', async () => {
    const other = await t.db.$client.reserve();
    try {
      await other`select pg_advisory_lock(${EXPIRE_ROOMS_LOCK})`;
      const room = await createRoom(t.app);
      await idleFor(room.roomId, 31);
      const result = await expireRooms(t.db, () => [], t.app.log);
      expect(result).toMatchObject({ deleted: 0, skipped: true });
      expect(await exists(room.roomId)).toBe(true);
    } finally {
      await other`select pg_advisory_unlock(${EXPIRE_ROOMS_LOCK})`;
      other.release();
    }
  });

  it('runs on demand from the dev route', async () => {
    const room = await createRoom(t.app);
    await idleFor(room.roomId, 31);
    const res = await t.app.inject({ method: 'POST', url: '/debug/jobs/expire-rooms' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: 1 });
  });
});

describe('msUntilNextHour', () => {
  it('is later today before the hour, tomorrow at or after it', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 23, h, m);
    expect(msUntilNextHour(at(3, 30), 4)).toBe(30 * 60_000);
    expect(msUntilNextHour(at(4, 0), 4)).toBe(24 * 3_600_000);
    expect(msUntilNextHour(at(23, 0), 4)).toBe(5 * 3_600_000);
  });
});
