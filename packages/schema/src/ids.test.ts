import { describe, expect, it } from 'vitest';
import { base62Id, ObjectId, RoomId } from './ids';

describe('RoomId', () => {
  it('accepts 22 base62 characters', () => {
    expect(RoomId.safeParse('0123456789abcdefABCDEF').success).toBe(true);
  });

  it.each([
    ['21 chars', '0123456789abcdefABCDE'],
    ['23 chars', '0123456789abcdefABCDEFG'],
    ['a dash', '0123456789abcdef-BCDEF'],
    ['an underscore', '0123456789abcdef_BCDEF'],
    ['a non-ascii letter', '0123456789abcdefABCDEé'],
    ['empty', ''],
  ])('rejects %s', (_, value) => {
    expect(RoomId.safeParse(value).success).toBe(false);
  });
});

describe('base62Id', () => {
  it('pads to the length and keeps zero bytes as zeros', () => {
    expect(base62Id(new Uint8Array(8), 12)).toBe('000000000000');
    expect(base62Id(new Uint8Array([1]), 4)).toBe('0001');
    expect(base62Id(new Uint8Array([62]), 2)).toBe('10');
  });

  it('fits 8 random bytes in a 12-char ObjectId', () => {
    const max = base62Id(new Uint8Array(8).fill(255), 12);
    expect(ObjectId.safeParse(max).success).toBe(true);
  });

  it('throws when the bytes do not fit', () => {
    expect(() => base62Id(new Uint8Array(16).fill(255), 12)).toThrow(RangeError);
  });
});
