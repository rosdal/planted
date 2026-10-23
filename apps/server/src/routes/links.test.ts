import { RotateLinksResponse } from '@planted/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers';
import {
  connectClient,
  createRoom,
  issueToken,
  listen,
  type TestClient,
  type TestRoom,
  until,
  waitForStatus,
} from '../test/realtime';

let t: TestApp;
let url: string;
const clients: TestClient[] = [];

beforeEach(async () => {
  t = await makeTestApp();
  url = await listen(t.app);
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await t.close();
});

/** A client that asks the route for a fresh token every time, like the web app. */
function client(room: TestRoom, key: () => string): TestClient {
  const c = connectClient(url, room.roomId, async () => {
    return (await issueToken(() => t.app, room.roomId, key())).token;
  });
  clients.push(c);
  return c;
}

async function rotate(room: TestRoom, key: string) {
  const { token } = await issueToken(() => t.app, room.roomId, key);
  return t.app.inject({
    method: 'POST',
    url: `/rooms/${room.roomId}/links/rotate`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('POST /rooms/:roomId/links/rotate', () => {
  it('drops old-link sockets with "link revoked", refuses the old keys, and the new ones work', async () => {
    const room = await createRoom(t.app);
    let editKey = room.editKey;
    const owner = client(room, () => editKey);
    const viewer = client(room, () => room.viewKey);
    await Promise.all([waitForStatus(owner, 'synced'), waitForStatus(viewer, 'synced')]);

    const res = await rotate(room, room.editKey);
    expect(res.statusCode).toBe(200);
    const keys = RotateLinksResponse.parse(res.json());
    expect(keys.editKey).not.toBe(room.editKey);
    // The owner's app stores the new key as soon as the response lands.
    editKey = keys.editKey;

    // 4401, a token refetch with the old key, a 403: the viewer is out for good.
    await until(() => viewer.stopReason !== null, { message: 'viewer stops' });
    expect(viewer.stopReason).toBe('link_revoked');
    // The owner refetches with the new key and is straight back in.
    await until(() => owner.status === 'synced' && owner.socket().readyState === 1);
    expect(owner.stopReason).toBeNull();

    const fresh = client(room, () => keys.viewKey);
    await waitForStatus(fresh, 'synced');
    expect(fresh.role).toBe('view');
  });

  it('refuses a view token with 403 and no token with 401', async () => {
    const room = await createRoom(t.app);
    expect((await rotate(room, room.viewKey)).statusCode).toBe(403);
    const res = await t.app.inject({ method: 'POST', url: `/rooms/${room.roomId}/links/rotate` });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a token from a link that was rotated away, even before it expires', async () => {
    const room = await createRoom(t.app);
    const { token } = await issueToken(() => t.app, room.roomId, room.editKey);
    expect((await rotate(room, room.editKey)).statusCode).toBe(200);
    const res = await t.app.inject({
      method: 'POST',
      url: `/rooms/${room.roomId}/links/rotate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
