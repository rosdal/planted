import { base62Id, RoomId } from '@planted/schema';

const LENGTH = 22; // 62^22 > 2^128, so any 16-byte value fits

/** 128 bits from the CSPRNG, base62, left-padded with '0' so it is always 22 characters. */
export function newRoomId(): RoomId {
  return RoomId.parse(base62Id(crypto.getRandomValues(new Uint8Array(16)), LENGTH));
}

/** Share link ids: 8 random bytes, base62, 12 characters (62^12 > 2^64). */
export function newLinkId(): string {
  return base62Id(crypto.getRandomValues(new Uint8Array(8)), 12);
}
