import { ApiError, RoomTokenResponse } from '@planted/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newLinkKey } from '../auth/links';
import { ROOM_TOKEN_TTL_S, RoomTokens } from '../auth/room-token';
import { newRoomId } from '../ids';
import { makeTestApp, type TestApp, testEnv } from '../test/helpers';
import { createRoom } from '../test/realtime';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

function requestToken(roomId: string, key: string) {
  return t.app.inject({ method: 'POST', url: `/rooms/${roomId}/token`, payload: { key } });
}

describe('POST /rooms/:roomId/token', () => {
  it.each(['edit', 'view'] as const)('trades the %s key for a 5-minute %s token', async (role) => {
    const room = await createRoom(t.app);
    const res = await requestToken(room.roomId, role === 'edit' ? room.editKey : room.viewKey);
    expect(res.statusCode).toBe(200);
    const body = RoomTokenResponse.parse(res.json());
    expect(body.role).toBe(role);
    const claims = await new RoomTokens({ secret: testEnv.ROOM_TOKEN_SECRET }).verify(body.token);
    expect(claims).toMatchObject({ roomId: room.roomId, role, lid: expect.any(String) });
    const ttl = (Date.parse(body.expiresAt) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(ROOM_TOKEN_TTL_S - 5);
    expect(ttl).toBeLessThanOrEqual(ROOM_TOKEN_TTL_S);
  });

  it("answers a wrong key, another room's key, a missing room and a malformed key alike: 403", async () => {
    const room = await createRoom(t.app);
    const other = await createRoom(t.app);
    const answers = await Promise.all([
      requestToken(room.roomId, newLinkKey()),
      requestToken(room.roomId, other.editKey),
      requestToken(newRoomId(), room.editKey),
      requestToken(room.roomId, 'not a key at all'),
    ]);
    for (const res of answers) {
      expect(res.statusCode).toBe(403);
      expect(ApiError.parse(res.json()).error).toEqual({
        code: 'forbidden',
        message: 'This link is not valid',
      });
    }
  });

  it('refuses a key whose link was revoked by a rotation', async () => {
    const room = await createRoom(t.app);
    const { token } = RoomTokenResponse.parse(
      (await requestToken(room.roomId, room.editKey)).json(),
    );
    const rotated = await t.app.inject({
      method: 'POST',
      url: `/rooms/${room.roomId}/links/rotate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rotated.statusCode).toBe(200);
    expect((await requestToken(room.roomId, room.editKey)).statusCode).toBe(403);
    expect((await requestToken(room.roomId, room.viewKey)).statusCode).toBe(403);
  });

  it('answers the 31st request in a minute with 429', async () => {
    const room = await createRoom(t.app);
    for (let i = 0; i < 30; i++) {
      expect((await requestToken(room.roomId, room.viewKey)).statusCode).toBe(200);
    }
    const res = await requestToken(room.roomId, room.viewKey);
    expect(res.statusCode).toBe(429);
  });

  it('rejects a body without a key with 400', async () => {
    const room = await createRoom(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: `/rooms/${room.roomId}/token`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
