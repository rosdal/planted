import { customType, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array }>({ dataType: () => 'bytea' });

export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(), // 22-char base62 RoomId
  mapId: text('map_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Encoded Y.Doc per room. Unused until 0.4; here so the first migration matches the design. */
export const roomDocs = pgTable('room_docs', {
  roomId: text('room_id')
    .primaryKey()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  ydoc: bytea('ydoc').notNull(),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
