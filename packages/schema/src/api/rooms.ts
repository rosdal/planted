import { z } from 'zod';
import { RoomId } from '../ids';
import { RoomRole } from '../protocol';

/** A share link's key: 32 random bytes, base64url, as it appears after `#k=` (ADR 0005). */
export const LinkKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `mapId` must be a map in the server's current content version. */
export const CreateRoomRequest = z.strictObject({ mapId: z.string().min(1).max(64) });
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;

/** The only time the raw link keys leave the server; they're stored as hashes. */
export const CreateRoomResponse = z.object({
  roomId: RoomId,
  createdAt: z.iso.datetime(),
  mapId: z.string(),
  contentVersion: z.string(),
  editKey: LinkKey,
  viewKey: LinkKey,
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;

export const RoomParams = z.object({ roomId: RoomId });
export type RoomParams = z.infer<typeof RoomParams>;

export const GetRoomResponse = z.object({
  roomId: RoomId,
  createdAt: z.iso.datetime(),
  /** Null for rooms created before 0.5, which have no map. */
  mapId: z.string().nullable(),
  contentVersion: z.string().nullable(),
});
export type GetRoomResponse = z.infer<typeof GetRoomResponse>;

/** Not `LinkKey`: a malformed key gets the same 403 as a wrong one. */
export const RoomTokenRequest = z.object({ key: z.string().min(1).max(128) });
export type RoomTokenRequest = z.infer<typeof RoomTokenRequest>;

export const RoomTokenResponse = z.object({
  token: z.string(),
  role: RoomRole,
  expiresAt: z.iso.datetime(),
});
export type RoomTokenResponse = z.infer<typeof RoomTokenResponse>;

export const RotateLinksResponse = z.object({ editKey: LinkKey, viewKey: LinkKey });
export type RotateLinksResponse = z.infer<typeof RotateLinksResponse>;

export const ClearRoomResponse = z.object({ roomEpoch: z.number().int().positive() });
export type ClearRoomResponse = z.infer<typeof ClearRoomResponse>;
