import { sql } from 'drizzle-orm';
import { check, customType, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array }>({ dataType: () => 'bytea' });

export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(), // 22-char base62 RoomId
  mapId: text('map_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  /** Bumps when the doc is replaced (clear, and snapshot restore in 0.9); see `welcome.roomEpoch`. */
  epoch: integer('epoch').notNull().default(1),
});

/** Encoded Y.Doc per room: the full state, rewritten on every save. */
export const roomDocs = pgTable('room_docs', {
  roomId: text('room_id')
    .primaryKey()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  ydoc: bytea('ydoc').notNull(),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Share links: one edit and one view link per room (ADR 0005). Only the SHA-256 of the key is
 * stored; the raw key exists only in the share URL. Rotating revokes rows rather than deleting
 * them, so a token minted from an old link is refused by its `lid`.
 */
export const roomLinks = pgTable(
  'room_links',
  {
    id: text('id').primaryKey(), // 12-char base62
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['edit', 'view'] }).notNull(),
    keyHash: bytea('key_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('room_links_room_id_idx').on(t.roomId),
    check('room_links_role_check', sql`${t.role} in ('edit', 'view')`),
  ],
);
