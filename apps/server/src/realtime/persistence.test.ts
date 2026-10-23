import { docHash, objectsOf } from '@planted/client';
import { CloseCode } from '@planted/protocol';
import type { RoomId } from '@planted/schema';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { buildApp } from '../app';
import { makeTestApp, type TestApp, testEnv } from '../test/helpers';
import {
  connectClient,
  createRoom,
  issueToken,
  listen,
  type TestClient,
  type TestRoom,
  tokenSource,
  until,
  waitForStatus,
} from '../test/realtime';
import { DocSaver, PgRoomStore, type RoomStore, retryDelay } from './persistence';
import { UNLOAD_AFTER_MS } from './room';

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as FastifyBaseLogger;

describe('DocSaver timing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function counting(): { saver: DocSaver; saves: () => number } {
    let saves = 0;
    const saver = new DocSaver({
      save: async () => {
        saves++;
      },
      log: silentLog,
    });
    return { saver, saves: () => saves };
  }

  it('saves once for 10 updates in 1 s, 2 s after the last', async () => {
    vi.useFakeTimers();
    const { saver, saves } = counting();
    for (let i = 0; i < 10; i++) {
      if (i > 0) await vi.advanceTimersByTimeAsync(100);
      saver.markDirty();
    }
    await vi.advanceTimersByTimeAsync(1999);
    expect(saves()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves()).toBe(1);
  });

  it('saves every 10 s under continuous updates: 3 saves in 30 s', async () => {
    vi.useFakeTimers();
    const { saver, saves } = counting();
    for (let ms = 0; ms < 30_000; ms += 100) {
      saver.markDirty();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(saves()).toBe(3);
  });

  it('never runs two saves at once, and saves again after one that raced an update', async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxRunning = 0;
    let saves = 0;
    let release: () => void = () => {};
    const saver = new DocSaver({
      save: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        running--;
        saves++;
      },
      log: silentLog,
    });
    saver.markDirty();
    await vi.advanceTimersByTimeAsync(2000);
    // First save in flight; an update arrives and its debounce passes.
    saver.markDirty();
    await vi.advanceTimersByTimeAsync(5000);
    expect(running).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(2000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toBe(2);
    expect(maxRunning).toBe(1);
    expect(saver.dirty).toBe(false);
  });

  it('retries a failed save after 1 s, 2 s, 4 s, and stays dirty until one succeeds', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    let failing = true;
    const saver = new DocSaver({
      save: async () => {
        attempts.push(Date.now());
        if (failing) throw new Error('db down');
      },
      log: silentLog,
    });
    const start = Date.now();
    saver.markDirty();
    await vi.advanceTimersByTimeAsync(2000 + 1000 + 2000 + 4000);
    expect(attempts.map((at) => at - start)).toEqual([2000, 3000, 5000, 9000]);
    expect(saver.failing).toBe(true);
    expect(saver.dirty).toBe(true);
    failing = false;
    await vi.advanceTimersByTimeAsync(8000);
    expect(saver.failing).toBe(false);
    expect(saver.dirty).toBe(false);
  });

  it('caps the retry delay at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(retryDelay)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe('persistence through Postgres', () => {
  let t: TestApp;
  let url: string;
  let tokens: ReturnType<typeof tokenSource>;
  const clients: TestClient[] = [];

  function client(room: TestRoom, key = room.editKey): TestClient {
    const c = connectClient(url, room.roomId, tokens(room.roomId, key));
    clients.push(c);
    return c;
  }

  function drawSquiggles(doc: Y.Doc, count: number): void {
    for (let i = 0; i < count; i++) {
      doc.transact(() => {
        const map = new Y.Map<unknown>();
        const fields = {
          kind: 'stroke',
          floor: 'test-1',
          phase: null,
          colour: '#57ab5a',
          width: 0.002,
          points: new Uint8Array(new Float32Array([i / count, 0.1, 0.5, 0.9]).buffer),
          by: 'test',
          at: i,
        };
        for (const [k, v] of Object.entries(fields)) map.set(k, v);
        objectsOf(doc).set(`squiggle${String(i).padStart(4, '0')}`, map);
      });
    }
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

  it('brings the doc back after a restart with an identical hash, with no client to re-upload it', async () => {
    const room = await createRoom(t.app);
    const a = client(room);
    await waitForStatus(a, 'synced');
    drawSquiggles(a.doc, 25);
    await until(() => objectsOf(t.app.realtime.get(room.roomId)?.doc ?? new Y.Doc()).size === 25);
    const before = docHash(a.doc);
    a.destroy();

    // Shutdown flushes the dirty room before the pool closes.
    const port = Number(new URL(url).port);
    await t.app.close();
    t.app = await buildApp({ db: t.db, env: testEnv });
    await listen(t.app, port);

    const b = client(room);
    await waitForStatus(b, 'synced');
    expect(objectsOf(b.doc).size).toBe(25);
    expect(docHash(b.doc)).toBe(before);
  });

  it('keeps a room whose saves fail loaded after everyone leaves, then saves once the database is back', async () => {
    await t.app.close();
    let down = false;
    let saves = 0;
    const real = new PgRoomStore(t.db);
    const store: RoomStore = {
      load: (roomId) => real.load(roomId),
      clear: (roomId) => real.clear(roomId),
      save: async (roomId, state) => {
        if (down) throw new Error('connection refused');
        saves++;
        await real.save(roomId, state);
      },
    };
    t.app = await buildApp({ db: t.db, env: testEnv, store });
    url = await listen(t.app);

    const room = await createRoom(t.app);
    const roomId = room.roomId as RoomId;
    const a = client(room);
    await waitForStatus(a, 'synced');
    down = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    drawSquiggles(a.doc, 3);
    await until(() => objectsOf(t.app.realtime.get(roomId)?.doc ?? new Y.Doc()).size === 3);
    a.destroy();
    await until(() => t.app.realtime.stats().conns === 0);

    // Debounce, a failing save, then the idle timeout: the unload is refused.
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => t.app.realtime.get(roomId)?.saver.failing === true);
    await vi.advanceTimersByTimeAsync(UNLOAD_AFTER_MS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.app.realtime.get(roomId)).toBeDefined();
    const debug = await t.app.inject({ method: 'GET', url: '/debug/realtime' });
    expect(debug.json().rooms).toEqual([expect.objectContaining({ roomId, unsaved: true })]);

    // Back up: the next retry saves, and the following idle check unloads it.
    down = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => saves === 1, { message: 'saved after recovery' });
    await vi.advanceTimersByTimeAsync(UNLOAD_AFTER_MS);
    await until(() => t.app.realtime.get(roomId) === undefined, { message: 'unloaded' });
    expect((await real.load(roomId))?.ydoc?.byteLength).toBeGreaterThan(100);
  });
});

describe('epochs', () => {
  let t: TestApp;
  let url: string;
  let tokens: ReturnType<typeof tokenSource>;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    t = await makeTestApp();
    url = await listen(t.app);
    tokens = tokenSource(() => t.app);
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await t.close();
  });

  function client(room: TestRoom): TestClient {
    const c = connectClient(url, room.roomId, tokens(room.roomId, room.editKey));
    clients.push(c);
    return c;
  }

  async function clear(room: TestRoom) {
    const { token } = await issueToken(() => t.app, room.roomId, room.editKey);
    return t.app.inject({
      method: 'POST',
      url: `/rooms/${room.roomId}/clear`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('/clear closes sockets with 4409, and a client holding old strokes does not bring them back', async () => {
    const room = await createRoom(t.app);
    const a = client(room);
    const b = client(room);
    await Promise.all([waitForStatus(a, 'synced'), waitForStatus(b, 'synced')]);
    a.doc.getArray<string>('debug-items').push(['old']);
    await until(() => b.doc.getArray('debug-items').length === 1);

    // B goes offline holding the old item, and even adds one more while away.
    b.setOnline(false);
    b.doc.getArray<string>('debug-items').push(['offline edit']);

    const closed = new Promise<number>((resolve) => a.socket().on('close', (c) => resolve(c)));
    const notices: string[] = [];
    a.on('notice', (n) => notices.push(n.code));
    const res = await clear(room);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ roomEpoch: 2 });
    expect(await closed).toBe(CloseCode.EpochChanged);

    await waitForStatus(a, 'synced');
    expect(a.epoch).toBe(2);
    expect(a.doc.getArray('debug-items').length).toBe(0);
    expect(notices).toContain('reset');

    b.setOnline(true);
    await until(() => b.epoch === 2 && b.status === 'synced', { message: 'B on epoch 2' });
    expect(b.doc.getArray('debug-items').length).toBe(0);
    const server = t.app.realtime.get(room.roomId as RoomId);
    expect(server?.doc.getArray('debug-items').length).toBe(0);
    expect(server?.epoch).toBe(2);
  });

  it('refuses /clear with a view token', async () => {
    const room = await createRoom(t.app);
    const { token } = await issueToken(() => t.app, room.roomId, room.viewKey);
    const res = await t.app.inject({
      method: 'POST',
      url: `/rooms/${room.roomId}/clear`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
