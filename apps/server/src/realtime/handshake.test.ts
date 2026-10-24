import { roomLinks } from '@planted/db';
import { CloseCode, controlFrame, sync1Frame } from '@planted/protocol';
import type { RoomId } from '@planted/schema';
import { EvilClient, putObject, strokeFields } from '@planted/scripts/evil-client';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomTokens } from '../auth/room-token';
import { makeTestApp, type TestApp, testEnv } from '../test/helpers';
import {
  connectClient,
  createRoom,
  issueToken,
  listen,
  peerIds,
  type TestClient,
  type TestRoom,
  tokenSource,
  until,
  waitForStatus,
} from '../test/realtime';
import { HELLO_TIMEOUT_MS } from './routes';

let t: TestApp;
let url: string;
let tokens: ReturnType<typeof tokenSource>;
const clients: TestClient[] = [];
const evils: EvilClient[] = [];

beforeEach(async () => {
  t = await makeTestApp();
  url = await listen(t.app);
  tokens = tokenSource(() => t.app);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) c.destroy();
  for (const e of evils.splice(0)) e.close();
  await t.close();
});

function client(room: TestRoom, key = room.editKey): TestClient {
  const c = connectClient(url, room.roomId, tokens(room.roomId, key));
  clients.push(c);
  return c;
}

async function evil(roomId: string): Promise<EvilClient> {
  const e = await EvilClient.connect(url, roomId);
  evils.push(e);
  return e;
}

async function tokenFor(room: TestRoom, key = room.editKey): Promise<string> {
  return tokens(room.roomId, key)();
}

describe('handshake', () => {
  it('answers hello with welcome: role, epoch 1 and the limits', async () => {
    const room = await createRoom(t.app);
    const e = await evil(room.roomId);
    const welcome = await e.join(await tokenFor(room));
    expect(welcome).toMatchObject({
      role: 'edit',
      roomEpoch: 1,
      limits: { maxFrameBytes: 256 * 1024, maxObjects: 20_000 },
    });
    expect(Math.abs(welcome.serverTime - Date.now())).toBeLessThan(5000);
  });

  it('closes with 4401 when no hello arrives within 5 s', async () => {
    const room = await createRoom(t.app);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const e = await evil(room.roomId);
    vi.advanceTimersByTime(HELLO_TIMEOUT_MS - 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(e.socket.readyState).toBe(e.socket.OPEN);
    vi.advanceTimersByTime(1);
    expect((await e.closed).code).toBe(CloseCode.BadToken);
  });

  it('closes with 4400 on a Yjs frame before welcome', async () => {
    const room = await createRoom(t.app);
    const e = await evil(room.roomId);
    e.send(sync1Frame(e.doc));
    expect((await e.closed).code).toBe(CloseCode.BadFrame);
  });

  it('closes with 4426 and an upgrade error for protocol 0', async () => {
    const room = await createRoom(t.app);
    const e = await evil(room.roomId);
    e.hello(await tokenFor(room), { protocol: 0 });
    expect((await e.closed).code).toBe(CloseCode.ProtocolTooOld);
    expect(e.errors()).toEqual(['upgrade']);
  });

  it('closes with 4401 for an expired token', async () => {
    const room = await createRoom(t.app);
    const [link] = await t.db
      .select({ id: roomLinks.id })
      .from(roomLinks)
      .where(and(eq(roomLinks.roomId, room.roomId), eq(roomLinks.role, 'edit')));
    if (!link) throw new Error('no edit link');
    // Same secret, but a clock 6 minutes back: the token expired a minute ago.
    const past = new RoomTokens({
      secret: testEnv.ROOM_TOKEN_SECRET,
      now: () => Date.now() - 6 * 60_000,
    });
    const { token } = await past.sign({ roomId: room.roomId, role: 'edit', lid: link.id });
    const e = await evil(room.roomId);
    e.hello(token);
    expect((await e.closed).code).toBe(CloseCode.BadToken);
  });

  it("closes with 4401 for another room's token", async () => {
    const room = await createRoom(t.app);
    const other = await createRoom(t.app);
    const e = await evil(room.roomId);
    e.hello(await tokenFor(other));
    expect((await e.closed).code).toBe(CloseCode.BadToken);
  });

  it('closes with 4400 on a second hello', async () => {
    const room = await createRoom(t.app);
    const e = await evil(room.roomId);
    const token = await tokenFor(room);
    await e.join(token);
    e.hello(token);
    expect((await e.closed).code).toBe(CloseCode.BadFrame);
  });

  it('answers a control ping with a pong carrying the same seq and t', async () => {
    const room = await createRoom(t.app);
    const e = await evil(room.roomId);
    await e.join(await tokenFor(room));
    e.send(controlFrame({ kind: 'ping', seq: 77, body: { t: 1234 } }));
    const pong = await e.waitFor(() => e.controls.find((c) => c.kind === 'pong'));
    expect(pong).toEqual({ kind: 'pong', seq: 77, body: { t: 1234 } });
  });

  it('refetches the token once after a 4401 and carries on', async () => {
    const room = await createRoom(t.app);
    const reasons: string[] = [];
    let first = true;
    const getToken = async (reason?: 'connect' | 'refresh') => {
      reasons.push(reason ?? 'connect');
      if (first) {
        first = false;
        return 'not-a-token';
      }
      return (await issueToken(() => t.app, room.roomId, room.editKey)).token;
    };
    const c = connectClient(url, room.roomId, getToken);
    clients.push(c);
    await waitForStatus(c, 'synced');
    expect(reasons).toEqual(['connect', 'refresh']);
  });
});

describe('roles', () => {
  it('never sends a viewer sync-1, and syncs it the doc', async () => {
    const room = await createRoom(t.app);
    const editor = client(room);
    await waitForStatus(editor, 'synced');
    editor.doc.getArray<string>('debug-items').push(['for the viewer']);
    const viewer = client(room, room.viewKey);
    await waitForStatus(viewer, 'synced');
    expect(viewer.role).toBe('view');
    await until(() => viewer.doc.getArray('debug-items').length === 1);
    const sync1s = viewer.socket().received.filter((f) => f.channel === 1 && f.type === 0);
    expect(sync1s).toEqual([]);
  });

  it("shows a viewer's cursor to editors", async () => {
    const room = await createRoom(t.app);
    const editor = client(room);
    const viewer = client(room, room.viewKey);
    viewer.awareness.setLocalStateField('cursor', { x: 0.5, y: 0.5 });
    await until(() => peerIds(editor).includes(viewer.doc.clientID), {
      message: 'editor sees viewer',
    });
  });

  it('closes a viewer that sends an update with 4403 and leaves the doc unchanged', async () => {
    const room = await createRoom(t.app);
    const editor = client(room);
    await waitForStatus(editor, 'synced');
    const e = await evil(room.roomId);
    expect((await e.join(await tokenFor(room, room.viewKey))).role).toBe('view');
    e.update((doc) => putObject(doc, 'viewer000001', strokeFields()));
    expect((await e.closed).code).toBe(CloseCode.Forbidden);
    const objects = t.app.realtime.get(room.roomId as RoomId)?.doc.getMap('objects');
    expect(objects?.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(editor.doc.getMap('objects').size).toBe(0);
  });
});
