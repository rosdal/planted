import { rooms } from '@planted/db';
import { CloseCode, encodeFrame } from '@planted/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { buildApp } from '../app';
import { makeTestApp, type TestApp, testEnv } from '../test/helpers';
import {
  connectClient,
  createRoom,
  listen,
  peerIds,
  type TestClient,
  type TestRoom,
  tokenSource,
  until,
  waitForStatus,
} from '../test/realtime';
import { UNLOAD_AFTER_MS } from './room';

let t: TestApp;
let url: string;
let tokens: ReturnType<typeof tokenSource>;
const clients: TestClient[] = [];

/** An editor on `room` unless another key is given. */
function client(room: TestRoom, key = room.editKey): TestClient {
  const c = connectClient(url, room.roomId, tokens(room.roomId, key));
  clients.push(c);
  return c;
}

beforeEach(async () => {
  t = await makeTestApp();
  url = await listen(t.app);
  tokens = tokenSource(() => t.app);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) c.destroy();
  await t.close();
});

// The dev-only root type the 0.2 debug page uses; the server allows it outside production.
const ITEMS = 'debug-items';

function items(c: TestClient): string[] {
  return c.doc.getArray<string>(ITEMS).toArray();
}

/** Resolves with the close code of a raw socket. */
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

describe('GET /rooms/:roomId/ws', () => {
  it('relays an insert from A to B within 100 ms and never echoes it to A', async () => {
    const room = await createRoom(t.app);
    const a = client(room);
    const b = client(room);
    await Promise.all([waitForStatus(a, 'synced'), waitForStatus(b, 'synced')]);

    const updatesToA = () => a.socket().received.filter((f) => f.channel === 1 && f.type === 2);
    const before = updatesToA().length;
    const start = performance.now();
    a.doc.getArray<string>(ITEMS).push(['hello']);
    await until(() => items(b).includes('hello'));
    expect(performance.now() - start).toBeLessThan(100);

    // Give a stray echo time to arrive before asserting there wasn't one.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(updatesToA().length).toBe(before);
  });

  it('syncs a doc bigger than the 256 KB frame cap in both directions', {
    timeout: 20_000,
  }, async () => {
    const room = await createRoom(t.app);
    const a = client(room);
    await waitForStatus(a, 'synced');
    // 40 updates of 10 KB: each fits a frame, the doc as a whole does not.
    for (let i = 0; i < 40; i++) a.doc.getArray<string>(ITEMS).push([`${i}`.padEnd(10_000, '.')]);
    await until(() => t.app.realtime.get(room.roomId)?.doc.getArray(ITEMS).length === 40);

    // Restart: the doc comes back from Postgres, and A's handshake merges in nothing new.
    const port = Number(new URL(url).port);
    await t.app.close();
    t.app = await buildApp({ db: t.db, env: testEnv });
    await listen(t.app, port);
    await until(() => t.app.realtime.get(room.roomId)?.doc.getArray(ITEMS).length === 40, {
      timeoutMs: 10_000,
      message: 'A reconnects',
    });

    // And a fresh joiner downloads it in one sync-2.
    const c = client(room);
    await waitForStatus(c, 'synced');
    expect(items(c)).toHaveLength(40);
  });

  it('gives a late joiner everything in its first sync-2', async () => {
    const room = await createRoom(t.app);
    const a = client(room);
    await waitForStatus(a, 'synced');
    a.doc.getArray<string>(ITEMS).push(['one', 'two', 'three']);
    a.doc.getArray<string>(ITEMS).delete(1, 1);
    await until(() => (t.app.realtime.get(room.roomId)?.doc.getArray(ITEMS).length ?? 0) === 2);

    const c = client(room);
    await waitForStatus(c, 'synced');
    const firstSync2 = c.socket().received.find((f) => f.channel === 1 && f.type === 1);
    if (!firstSync2) throw new Error('no sync-2 received');
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, firstSync2.payload);
    expect(fresh.getArray(ITEMS).toArray()).toEqual(['one', 'three']);
  });

  it('closes with 4404 for a malformed id, and for a room deleted after its token was issued', async () => {
    const malformed = connectClient(url, 'not-a-room', async () => 'irrelevant');
    clients.push(malformed);
    const room = await createRoom(t.app);
    const getToken = tokens(room.roomId, room.editKey);
    await getToken();
    await t.db.delete(rooms).where(eq(rooms.id, room.roomId));
    const deleted = connectClient(url, room.roomId, getToken);
    clients.push(deleted);

    await until(() => malformed.stopReason !== null);
    expect(malformed.stopReason).toBe('room_not_found');
    // The cascade took the links too, so the cached token's link check fails first.
    await until(() => deleted.stopReason !== null);
    expect(deleted.stopReason).toBe('link_revoked');
  });

  it.each([
    ['an unknown channel', new Uint8Array([9, 0])],
    ['a short frame', new Uint8Array([1])],
    ['a text frame', 'hello'],
    [
      'an update that is not Yjs',
      encodeFrame({ channel: 1, type: 2, payload: new Uint8Array([255, 255, 255, 1]) }),
    ],
  ])('closes with 4400 on %s and leaves the others alone', async (_, garbage) => {
    const room = await createRoom(t.app);
    const a = client(room);
    const b = client(room);
    await Promise.all([waitForStatus(a, 'synced'), waitForStatus(b, 'synced')]);

    const raw = new WebSocket(`${url}/rooms/${room.roomId}/ws`);
    await new Promise((resolve) => raw.on('open', resolve));
    const closed = closeCode(raw);
    raw.send(garbage);
    expect(await closed).toBe(CloseCode.BadFrame);

    a.doc.getArray<string>(ITEMS).push(['still works']);
    await until(() => items(b).includes('still works'));
    expect(t.app.realtime.get(room.roomId)?.conns.size).toBe(2);
  });

  it('drops a closed peer from awareness within 1 s', async () => {
    const room = await createRoom(t.app);
    const a = client(room);
    const b = client(room);
    a.awareness.setLocalStateField('user', { name: 'A' });
    b.awareness.setLocalStateField('user', { name: 'B' });
    await until(() => peerIds(b).includes(a.doc.clientID), { message: 'B sees A' });

    // Not destroy(): that clears presence first. Here only the server's cleanup on close runs.
    const start = performance.now();
    a.setOnline(false);
    await until(() => !peerIds(b).includes(a.doc.clientID), { message: 'B drops A' });
    expect(performance.now() - start).toBeLessThan(1000);

    // Back online, A shows up again even though its awareness clock was already seen.
    a.setOnline(true);
    await until(() => peerIds(b).includes(a.doc.clientID), { message: 'B sees A again' });
  });

  it('unloads a room 60 s after the last client leaves, and keeps it on an earlier rejoin', async () => {
    const room = await createRoom(t.app);
    const { roomId } = room;
    const a = client(room);
    await waitForStatus(a, 'synced');
    a.doc.getArray<string>(ITEMS).push(['kept']);
    await until(() => t.app.realtime.get(roomId)?.doc.getArray(ITEMS).length === 1);

    // Only timeouts are faked: sockets, polling (setImmediate) and intervals stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    a.destroy();
    await until(() => t.app.realtime.stats().conns === 0);
    vi.advanceTimersByTime(UNLOAD_AFTER_MS - 1000);
    expect(t.app.realtime.get(roomId)).toBeDefined();

    // The rejoiner gets "kept" from the server, since A is gone.
    const b = client(room);
    await waitForStatus(b, 'synced');
    expect(items(b)).toEqual(['kept']);
    vi.advanceTimersByTime(UNLOAD_AFTER_MS);
    expect(t.app.realtime.get(roomId)).toBeDefined();

    b.destroy();
    await until(() => t.app.realtime.stats().conns === 0);
    vi.advanceTimersByTime(UNLOAD_AFTER_MS - 1);
    expect(t.app.realtime.get(roomId)).toBeDefined();
    vi.advanceTimersByTime(1);
    // Unloading waits for the final save, which is real I/O.
    await until(() => t.app.realtime.get(roomId) === undefined, { message: 'unloaded' });
    expect(t.app.realtime.stats().rooms).toEqual([]);
  });

  it('survives a server restart: clients reconnect, and offline edits merge', async () => {
    const room = await createRoom(t.app);
    const a = client(room);
    const b = client(room);
    await Promise.all([waitForStatus(a, 'synced'), waitForStatus(b, 'synced')]);
    a.doc.getArray<string>(ITEMS).push(['before restart']);
    await until(() => items(b).includes('before restart'));

    const port = Number(new URL(url).port);
    const closes = [a, b].map(
      (c) => new Promise<number>((resolve) => c.socket().on('close', (code) => resolve(code))),
    );
    await t.app.close();
    expect(await Promise.all(closes)).toEqual([CloseCode.GoingAway, CloseCode.GoingAway]);
    expect(a.status).toBe('offline');

    // Offline edits stay local and merge after the restart.
    b.doc.getArray<string>(ITEMS).push(['while down']);

    const app = await buildApp({ db: t.db, env: testEnv });
    t.app = app;
    await listen(app, port);
    await until(() => a.status === 'synced' && b.status === 'synced', {
      timeoutMs: 10_000,
      message: 'both resynced',
    });

    const c = client(room);
    await waitForStatus(c, 'synced');
    await until(() => items(c).length === 2 && items(a).length === 2);
    expect(new Set(items(c))).toEqual(new Set(['before restart', 'while down']));
    expect(items(a)).toEqual(items(c));
  });
});

describe('GET /debug/realtime', () => {
  it('lists loaded rooms with their connection count, doc size and save state', async () => {
    const room = await createRoom(t.app);
    const a = client(room);
    await waitForStatus(a, 'synced');
    const res = await t.app.inject({ method: 'GET', url: '/debug/realtime' });
    expect(res.json()).toEqual({
      rooms: [{ roomId: room.roomId, conns: 1, docBytes: expect.any(Number), unsaved: false }],
      conns: 1,
      process: {
        rssBytes: expect.any(Number),
        cpuMicros: expect.any(Number),
        loopP99Ms: expect.any(Number),
      },
    });
  });

  it('is not registered in production', async () => {
    const app = await buildApp({ db: t.db, env: { ...testEnv, NODE_ENV: 'production' } });
    const res = await app.inject({ method: 'GET', url: '/debug/realtime' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
