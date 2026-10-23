import { rooms } from '@planted/db';
import { ApiError, CreateRoomResponse, GetRoomResponse } from '@planted/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newRoomId } from '../ids';
import { makeTestApp, type TestApp } from '../test/helpers';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('POST /rooms', () => {
  it('returns 201 and writes the row', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/rooms' });
    expect(res.statusCode).toBe(201);
    const body = CreateRoomResponse.parse(res.json());
    const rows = await t.db.select().from(rooms).where(eq(rooms.id, body.roomId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt.toISOString()).toBe(body.createdAt);
  });

  it('answers the 11th request in a minute with 429 in the ApiError shape', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await t.app.inject({ method: 'POST', url: '/rooms' });
      expect(res.statusCode).toBe(201);
    }
    const res = await t.app.inject({ method: 'POST', url: '/rooms' });
    expect(res.statusCode).toBe(429);
    expect(ApiError.parse(res.json()).error.code).toBe('rate_limited');
  });
});

describe('GET /rooms/:roomId', () => {
  it('reads back a created room', async () => {
    const created = CreateRoomResponse.parse(
      (await t.app.inject({ method: 'POST', url: '/rooms' })).json(),
    );
    const res = await t.app.inject({ method: 'GET', url: `/rooms/${created.roomId}` });
    expect(res.statusCode).toBe(200);
    expect(GetRoomResponse.parse(res.json())).toEqual({ ...created, mapId: null });
  });

  it('returns 404 not_found for a valid id that does not exist', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/rooms/${newRoomId()}` });
    expect(res.statusCode).toBe(404);
    expect(ApiError.parse(res.json()).error.code).toBe('not_found');
  });

  it('returns 400 bad_request for a malformed id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/rooms/not-a-real-id' });
    expect(res.statusCode).toBe(400);
    expect(ApiError.parse(res.json()).error.code).toBe('bad_request');
  });
});

describe('unknown routes', () => {
  it('return 404 in the ApiError shape', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(ApiError.parse(res.json()).error.code).toBe('not_found');
  });
});
