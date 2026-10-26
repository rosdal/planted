import { z } from 'zod';

/** Name of the root `Y.Map` holding the room's `RoomMeta`. */
export const META = 'meta';

/**
 * Written by the server when the room is created and never by a client: a client update that
 * touches `meta` is reverted and its socket closed with 4400. Rooms created before 0.5 have none.
 */
export const RoomMeta = z.object({
  mapId: z.string().min(1).max(64),
  /** The content version the room pinned at creation, e.g. `y11s3.1`. */
  contentVersion: z.string().min(1).max(32),
  createdAt: z.iso.datetime(),
});
export type RoomMeta = z.infer<typeof RoomMeta>;
