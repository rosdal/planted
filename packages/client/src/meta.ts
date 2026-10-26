import { META, RoomMeta } from '@planted/schema';
import * as Y from 'yjs';

/**
 * The doc a room starts with: just its `meta`. The server saves it before `POST /rooms` answers,
 * so every client's first sync already carries the map.
 */
export function initialDocState(meta: RoomMeta): Uint8Array {
  const doc = new Y.Doc();
  const map = doc.getMap(META);
  doc.transact(() => {
    for (const [key, value] of Object.entries(meta)) map.set(key, value);
  });
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/** The room's meta, or null for a room created before 0.5 (or one whose meta hasn't synced). */
export function readMeta(doc: Y.Doc): RoomMeta | null {
  const map = doc.getMap(META);
  if (map.size === 0) return null;
  const parsed = RoomMeta.safeParse(map.toJSON());
  return parsed.success ? parsed.data : null;
}
