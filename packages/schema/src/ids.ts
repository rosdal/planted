import { z } from 'zod';

/** 16 random bytes, base62-encoded and left-padded to a fixed 22 characters. */
export const RoomId = z
  .string()
  .regex(/^[0-9A-Za-z]{22}$/)
  .brand<'RoomId'>();
export type RoomId = z.infer<typeof RoomId>;
