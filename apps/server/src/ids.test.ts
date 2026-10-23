import { RoomId } from '@planted/schema';
import { describe, expect, it } from 'vitest';
import { newRoomId } from './ids';

describe('newRoomId', () => {
  it('is always 22 characters and a valid RoomId, with no duplicates in 10k', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = newRoomId();
      expect(id).toHaveLength(22);
      expect(RoomId.safeParse(id).success).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(10_000);
  });
});
