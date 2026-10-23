import { RoomId } from '@planted/schema';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LENGTH = 22; // 62^22 > 2^128, so any 16-byte value fits

/** 128 bits from the CSPRNG, base62, left-padded with '0' so it is always 22 characters. */
export function newRoomId(): RoomId {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = '';
  while (n > 0n) {
    out = ALPHABET.charAt(Number(n % 62n)) + out;
    n /= 62n;
  }
  return RoomId.parse(out.padStart(LENGTH, '0'));
}
