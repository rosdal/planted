import { z } from 'zod';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Random bytes as base62, left-padded with '0' to `length`. The one id generator for rooms and
 * board objects; callers pass the bytes (from `crypto.getRandomValues`) so this stays pure.
 * `length` must fit the bytes: 62^length ≥ 256^bytes.length.
 */
export function base62Id(bytes: Uint8Array, length: number): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = '';
  while (n > 0n) {
    out = BASE62.charAt(Number(n % 62n)) + out;
    n /= 62n;
  }
  if (out.length > length) throw new RangeError(`${bytes.length} bytes overflow ${length} chars`);
  return out.padStart(length, '0');
}

/** 16 random bytes, base62-encoded and left-padded to a fixed 22 characters. */
export const RoomId = z
  .string()
  .regex(/^[0-9A-Za-z]{22}$/)
  .brand<'RoomId'>();
export type RoomId = z.infer<typeof RoomId>;

/** Board object ids: 8 random bytes (64 bits), base62, 12 characters. */
export const ObjectId = z.string().regex(/^[0-9A-Za-z]{12}$/);
export const OBJECT_ID_BYTES = 8;
export const OBJECT_ID_LENGTH = 12;
