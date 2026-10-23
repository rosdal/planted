import type { roomDocs, rooms } from './schema';

export { createDb, type Db } from './client';
export * from './schema';

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;
export type RoomDoc = typeof roomDocs.$inferSelect;
