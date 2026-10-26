import { readMeta } from '@planted/client';
import { floorIds, MAP_IDS } from '@planted/content';
import { TEST_FLOOR } from '@planted/schema';
import type * as Y from 'yjs';

/** The map scripts create rooms on: the first in the current content version. */
export const DEFAULT_MAP_ID = MAP_IDS[0] as string;
/** A floor of `DEFAULT_MAP_ID`, for strokes in rooms the scripts made themselves. */
export const DEFAULT_FLOOR = floorIds(DEFAULT_MAP_ID)?.[0] ?? TEST_FLOOR;

/** `fetch` options for `POST /rooms`. */
export function createRoomInit(mapId = DEFAULT_MAP_ID): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mapId }),
  };
}

/**
 * The floor to draw on in a synced room: its map's lowest floor, or the 0.3 test floor in a
 * room that predates maps. The server rejects strokes on any other floor.
 */
export function floorFor(doc: Y.Doc): string {
  const meta = readMeta(doc);
  if (!meta) return TEST_FLOOR;
  return floorIds(meta.mapId)?.[0] ?? TEST_FLOOR;
}
