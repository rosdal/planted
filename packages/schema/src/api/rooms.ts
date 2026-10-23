import { z } from 'zod';
import { RoomId } from '../ids';

export const CreateRoomResponse = z.object({ roomId: RoomId, createdAt: z.iso.datetime() });
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;

export const GetRoomParams = z.object({ roomId: RoomId });
export type GetRoomParams = z.infer<typeof GetRoomParams>;

export const GetRoomResponse = z.object({
  roomId: RoomId,
  createdAt: z.iso.datetime(),
  mapId: z.string().nullable(),
});
export type GetRoomResponse = z.infer<typeof GetRoomResponse>;
