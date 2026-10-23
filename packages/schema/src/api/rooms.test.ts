import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { CreateRoomResponse, GetRoomResponse } from './rooms';

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('room DTOs', () => {
  const roomId = '0123456789abcdefABCDEF';
  const createdAt = new Date('2026-10-23T12:00:00.000Z').toISOString();
  const editKey = 'A'.repeat(43);
  const viewKey = 'b-_'.repeat(14).concat('c');

  it('CreateRoomResponse survives JSON', () => {
    const dto = CreateRoomResponse.parse({ roomId, createdAt, editKey, viewKey });
    expect(CreateRoomResponse.parse(roundTrip(dto))).toEqual(dto);
  });

  it('GetRoomResponse survives JSON, with and without a map', () => {
    for (const mapId of [null, 'clubhouse']) {
      const dto = GetRoomResponse.parse({ roomId, createdAt, mapId });
      expect(GetRoomResponse.parse(roundTrip(dto))).toEqual(dto);
    }
  });

  it('rejects a createdAt that is not an ISO datetime', () => {
    expect(
      CreateRoomResponse.safeParse({ roomId, createdAt: 'yesterday', editKey, viewKey }).success,
    ).toBe(false);
  });

  it('rejects a link key that is not 43 base64url characters', () => {
    for (const key of ['A'.repeat(42), `${'A'.repeat(42)}=`, `${'A'.repeat(42)}/`]) {
      expect(
        CreateRoomResponse.safeParse({ roomId, createdAt, editKey: key, viewKey }).success,
      ).toBe(false);
    }
  });

  it('ApiError survives JSON', () => {
    const dto = ApiError.parse({ error: { code: 'not_found', message: 'Room not found' } });
    expect(ApiError.parse(roundTrip(dto))).toEqual(dto);
  });
});
