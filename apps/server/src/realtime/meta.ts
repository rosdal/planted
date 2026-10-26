import { floorIds } from '@planted/content';
import { type RoomMeta, TEST_FLOOR } from '@planted/schema';

/**
 * Floors a stroke may name in this room. A room without meta predates maps and keeps the 0.3
 * test floor. A map missing from the bundled content (dropped from a later version) allows no
 * floor at all, which only blocks drawing; the room still loads.
 *
 * Floors come from the content bundled with the server, not the room's pinned version; floor ids
 * don't change between seasons, and 0.9's migrations will cover the case where one does.
 */
export function allowedFloors(meta: RoomMeta | null): ReadonlySet<string> {
  if (!meta) return new Set([TEST_FLOOR]);
  return new Set(floorIds(meta.mapId) ?? []);
}
