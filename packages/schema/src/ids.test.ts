import { describe, expect, it } from 'vitest';
import { RoomId } from './ids';

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
