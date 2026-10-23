import { createHash, timingSafeEqual } from 'node:crypto';
import { type Db, roomLinks } from '@planted/db';
import type { RoomId, RoomRole } from '@planted/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { newLinkId } from '../ids';

/** A transaction handle or the pool: link writes run inside room creation and rotation. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type LinkKeys = { editKey: string; viewKey: string };

/** 32 random bytes, base64url: the secret in a share URL's fragment. */
export function newLinkKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/** Only this is stored. A plain SHA-256 is enough: the key is 256 random bits, not a password. */
export function hashLinkKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

/** One edit and one view link for `roomId`; the raw keys are returned once and never stored. */
export async function createLinks(db: DbOrTx, roomId: RoomId): Promise<LinkKeys> {
  const editKey = newLinkKey();
  const viewKey = newLinkKey();
  await db.insert(roomLinks).values([
    { id: newLinkId(), roomId, role: 'edit', keyHash: hashLinkKey(editKey) },
    { id: newLinkId(), roomId, role: 'view', keyHash: hashLinkKey(viewKey) },
  ]);
  return { editKey, viewKey };
}

/** Revokes every active link of the room and issues a fresh pair, in one transaction. */
export async function rotateLinks(db: Db, roomId: RoomId): Promise<LinkKeys> {
  return db.transaction(async (tx) => {
    await tx
      .update(roomLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(roomLinks.roomId, roomId), isNull(roomLinks.revokedAt)));
    return createLinks(tx, roomId);
  });
}

/**
 * The active link whose key this is, or null. A missing room, a revoked link and a wrong key
 * all take the same path: one query for the room's active links, then a constant-time compare
 * against every one of them with no early exit, so the timing doesn't say which it was.
 */
export async function findLinkByKey(
  db: Db,
  roomId: RoomId,
  key: string,
): Promise<{ id: string; role: RoomRole } | null> {
  const rows = await db
    .select({ id: roomLinks.id, role: roomLinks.role, keyHash: roomLinks.keyHash })
    .from(roomLinks)
    .where(and(eq(roomLinks.roomId, roomId), isNull(roomLinks.revokedAt)));
  const hash = hashLinkKey(key);
  let match: { id: string; role: RoomRole } | null = null;
  for (const row of rows) {
    const stored = Buffer.from(row.keyHash);
    if (stored.byteLength === hash.byteLength && timingSafeEqual(stored, hash)) {
      match = { id: row.id, role: row.role };
    }
  }
  return match;
}

/** True while link `lid` of `roomId` exists and isn't revoked. Checked on every token use. */
export async function isLinkActive(db: Db, roomId: RoomId, lid: string): Promise<boolean> {
  const rows = await db
    .select({ id: roomLinks.id })
    .from(roomLinks)
    .where(and(eq(roomLinks.id, lid), eq(roomLinks.roomId, roomId), isNull(roomLinks.revokedAt)));
  return rows.length > 0;
}
