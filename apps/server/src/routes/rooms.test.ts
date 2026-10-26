import { createHash } from 'node:crypto';
import { readMeta } from '@planted/client';
import { CONTENT_VERSION } from '@planted/content';
import { roomDocs, roomLinks, rooms } from '@planted/db';
import { ApiError, CreateRoomResponse, GetRoomResponse } from '@planted/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { newRoomId } from '../ids';
import { makeTestApp, type TestApp } from '../test/helpers';
import { createRoom, issueToken, TEST_MAP_ID } from '../test/realtime';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('POST /rooms', () => {
  it('returns 201 with an edit and a view key, and stores only their hashes', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { mapId: TEST_MAP_ID },
    });
    expect(res.statusCode).toBe(201);
    const body = CreateRoomResponse.parse(res.json());
    const [room] = await t.db.select().from(rooms).where(eq(rooms.id, body.roomId));
    expect(room?.createdAt.toISOString()).toBe(body.createdAt);
    expect(room?.epoch).toBe(1);

    const links = await t.db.select().from(roomLinks).where(eq(roomLinks.roomId, body.roomId));
    const sha = (key: string) => createHash('sha256').update(key).digest('hex');
    expect(links.map((l) => [l.role, Buffer.from(l.keyHash).toString('hex')]).sort()).toEqual([
      ['edit', sha(body.editKey)],
      ['view', sha(body.viewKey)],
    ]);
    expect(body.editKey).not.toBe(body.viewKey);
  });

  it('refuses an unknown map with 400 and creates nothing', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { mapId: 'atlantis' },
    });
    expect(res.statusCode).toBe(400);
    expect(ApiError.parse(res.json()).error.code).toBe('bad_request');
    expect(await t.db.select().from(rooms)).toEqual([]);
  });

  it('refuses a request without a mapId with 400', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/rooms' });
    expect(res.statusCode).toBe(400);
  });

  it('saves the initial doc with the room meta before answering', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { mapId: TEST_MAP_ID },
    });
    const body = CreateRoomResponse.parse(res.json());
    const [row] = await t.db.select().from(roomDocs).where(eq(roomDocs.roomId, body.roomId));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row?.ydoc ?? new Uint8Array());
    expect(readMeta(doc)).toEqual({
      mapId: TEST_MAP_ID,
      contentVersion: CONTENT_VERSION,
      createdAt: body.createdAt,
    });
    const [room] = await t.db.select().from(rooms).where(eq(rooms.id, body.roomId));
    expect(room).toMatchObject({ mapId: TEST_MAP_ID, contentVersion: CONTENT_VERSION });
  });

  it('answers the 11th request in a minute with 429 in the ApiError shape', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/rooms',
        payload: { mapId: TEST_MAP_ID },
      });
      expect(res.statusCode).toBe(201);
    }
    const res = await t.app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { mapId: TEST_MAP_ID },
    });
    expect(res.statusCode).toBe(429);
    expect(ApiError.parse(res.json()).error.code).toBe('rate_limited');
  });
});

describe('GET /rooms/:roomId', () => {
  it('reads back a created room with a view token', async () => {
    const room = await createRoom(t.app);
    const { token } = await issueToken(() => t.app, room.roomId, room.viewKey);
    const res = await t.app.inject({
      method: 'GET',
      url: `/rooms/${room.roomId}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(GetRoomResponse.parse(res.json())).toMatchObject({
      roomId: room.roomId,
      mapId: TEST_MAP_ID,
      contentVersion: CONTENT_VERSION,
    });
  });

  it('returns 401 without a token, which 0.1 used to allow', async () => {
    const room = await createRoom(t.app);
    const res = await t.app.inject({ method: 'GET', url: `/rooms/${room.roomId}` });
    expect(res.statusCode).toBe(401);
    expect(ApiError.parse(res.json()).error.code).toBe('unauthorized');
  });

  it('returns 401 for a token that is not one of ours', async () => {
    const room = await createRoom(t.app);
    const res = await t.app.inject({
      method: 'GET',
      url: `/rooms/${room.roomId}`,
      headers: bearer('eyJhbGciOiJIUzI1NiJ9.e30.x'),
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for another room's token", async () => {
    const mine = await createRoom(t.app);
    const other = await createRoom(t.app);
    const { token } = await issueToken(() => t.app, other.roomId, other.editKey);
    const res = await t.app.inject({
      method: 'GET',
      url: `/rooms/${mine.roomId}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(403);
    expect(ApiError.parse(res.json()).error.code).toBe('forbidden');
  });

  it('returns 400 bad_request for a malformed id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/rooms/not-a-real-id' });
    expect(res.statusCode).toBe(400);
    expect(ApiError.parse(res.json()).error.code).toBe('bad_request');
  });

  it('returns 401 for a valid id with no room behind it', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/rooms/${newRoomId()}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('unknown routes', () => {
  it('return 404 in the ApiError shape', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(ApiError.parse(res.json()).error.code).toBe('not_found');
  });
});
