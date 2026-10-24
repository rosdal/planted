import { objectsOf } from '@planted/client';
import { CloseCode, updateFrame } from '@planted/protocol';
import type { RoomId } from '@planted/schema';
import { EvilClient, putObject, strokeFields } from '@planted/scripts/evil-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { makeTestApp, type TestApp } from '../test/helpers';
import {
  connectClient,
  createRoom,
  listen,
  type TestClient,
  type TestRoom,
  tokenSource,
  until,
  waitForStatus,
} from '../test/realtime';
import { LAG_LIMIT_MS } from './connection';
import { MAX_OBJECTS, MAX_SOCKETS_PER_ROOM, SocketLimiter } from './limits';
import { SERVER_ORIGIN } from './room';
import { checkObject } from './validation';

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
  for (const c of clients.splice(0)) c.destroy();
  for (const e of evils.splice(0)) e.close();
  await t.close();
});

function client(room: TestRoom): TestClient {
  const c = connectClient(url, room.roomId, tokens(room.roomId, room.editKey));
  clients.push(c);
  return c;
}

async function evilEditor(room: TestRoom): Promise<EvilClient> {
  const e = await EvilClient.connect(url, room.roomId);
  evils.push(e);
  await e.join(await tokens(room.roomId, room.editKey)());
  return e;
}

const serverObjects = (room: TestRoom) =>
  t.app.realtime.get(room.roomId as RoomId)?.doc.getMap('objects');

describe('checkObject', () => {
  it('accepts a valid stroke', () => {
    const doc = new Y.Doc();
    putObject(doc, 'abcdefABCDEF', strokeFields());
    expect(checkObject('abcdefABCDEF', objectsOf(doc).get('abcdefABCDEF'))).toBeNull();
  });

  it.each([
    ['a named colour', 'abcdefABCDEF', strokeFields({ colour: 'red' }), 'colour'],
    ['a malformed id', 'short', strokeFields(), 'id'],
    ['an unknown kind', 'abcdefABCDEF', strokeFields({ kind: 'laser' }), 'kind'],
  ])('rejects %s', (_, id, fields, field) => {
    const doc = new Y.Doc();
    putObject(doc, id, fields);
    expect(checkObject(id, objectsOf(doc).get(id))?.issues.join(' ')).toContain(field);
  });

  it('rejects a value that is not a nested map', () => {
    expect(checkObject('abcdefABCDEF', 'a string')?.issues).toEqual(['not a nested Y.Map']);
  });
});

describe('validation after apply', () => {
  it('deletes an invalid stroke, closes the sender with 4400, and the honest client never holds it', async () => {
    const room = await createRoom(t.app);
    const honest = client(room);
    await waitForStatus(honest, 'synced');
    const seen = new Set<string>();
    objectsOf(honest.doc).observe((event) => {
      for (const key of event.keysChanged) if (objectsOf(honest.doc).has(key)) seen.add(key);
    });

    const evil = await evilEditor(room);
    evil.update((doc) => putObject(doc, 'evil00000001', strokeFields({ colour: 'red' })));
    expect((await evil.closed).code).toBe(CloseCode.BadFrame);
    expect(evil.errors()).toEqual(['invalid_object']);

    // A valid stroke from the honest client still gets through afterwards.
    honest.doc.transact(() => putObject(honest.doc, 'good00000001', strokeFields()));
    await until(() => serverObjects(room)?.has('good00000001') === true);
    expect(serverObjects(room)?.has('evil00000001')).toBe(false);
    expect(seen.has('evil00000001')).toBe(false);
    expect(objectsOf(honest.doc).has('evil00000001')).toBe(false);
  });

  it('still removes an invalid object from an update whose delete set fails to decode', async () => {
    const room = await createRoom(t.app);
    const honest = client(room);
    await waitForStatus(honest, 'synced');
    const evil = await evilEditor(room);
    // Yjs integrates the structs before it reads the delete set, so a truncated delete set
    // throws after the bad object is already in the doc.
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(evil.doc));
    let update: Uint8Array | null = null;
    local.on('update', (u: Uint8Array) => {
      update = u;
    });
    putObject(local, 'trunc0000001', strokeFields({ colour: 'red' }));
    if (!update) throw new Error('no update');
    const truncated = (update as Uint8Array).slice(0, -1);
    evil.send(updateFrame(truncated));
    expect((await evil.closed).code).toBe(CloseCode.BadFrame);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(serverObjects(room)?.has('trunc0000001')).toBe(false);
    expect(objectsOf(honest.doc).has('trunc0000001')).toBe(false);
  });

  it('closes the sender with 4400 for a new unknown root type', async () => {
    const room = await createRoom(t.app);
    const evil = await evilEditor(room);
    evil.update((doc) => doc.getMap('sneaky').set('x', 1));
    expect((await evil.closed).code).toBe(CloseCode.BadFrame);
  });

  it('removes what an unknown root holds, so peers end with it empty', async () => {
    const room = await createRoom(t.app);
    const honest = client(room);
    await waitForStatus(honest, 'synced');
    const evil = await evilEditor(room);
    evil.update((doc) => doc.getMap('sneaky').set('payload', 'x'.repeat(10_000)));
    expect((await evil.closed).code).toBe(CloseCode.BadFrame);
    await until(() => honest.doc.share.has('sneaky'));
    expect(honest.doc.getMap('sneaky').size).toBe(0);
    expect(t.app.realtime.get(room.roomId as RoomId)?.doc.getMap('sneaky').size).toBe(0);
  });

  it('flags writes to an unknown root that already exists, e.g. one saved earlier', async () => {
    const room = await createRoom(t.app);
    const server = await t.app.realtime.getOrCreate(room.roomId as RoomId);
    if (!server) throw new Error('room did not load');
    server.doc.transact(() => server.doc.getMap('junk').set('old', 1), SERVER_ORIGIN);
    const evil = await evilEditor(room);
    evil.update((doc) => doc.getMap('junk').set('new', 'x'));
    expect((await evil.closed).code).toBe(CloseCode.BadFrame);
    expect(server.doc.getMap('junk').has('new')).toBe(false);
  });

  it('accepts the allowed roots: objects, meta, and the dev-only debug list', async () => {
    const room = await createRoom(t.app);
    const evil = await evilEditor(room);
    evil.update((doc) => doc.getMap('meta').set('mapId', 'clubhouse'));
    evil.update((doc) => doc.getArray('debug-items').push(['x']));
    await until(
      () => t.app.realtime.get(room.roomId as RoomId)?.doc.getArray('debug-items').length === 1,
    );
    expect(evil.socket.readyState).toBe(evil.socket.OPEN);
  });
});

describe('limits', () => {
  it('closes a socket whose Yjs frames stay over the rate limit with 4429', {
    timeout: 10_000,
  }, async () => {
    const room = await createRoom(t.app);
    const evil = await evilEditor(room);
    const flood = setInterval(() => {
      for (let i = 0; i < 40; i++) evil.update((doc) => doc.getMap('meta').set('n', i));
    }, 20);
    try {
      expect((await evil.closed).code).toBe(CloseCode.RateLimited);
    } finally {
      clearInterval(flood);
    }
  });

  it('rejects object 20,001: the new object is removed and the sender warned, not closed', {
    timeout: 30_000,
  }, async () => {
    const room = await createRoom(t.app);
    const server =
      t.app.realtime.get(room.roomId as RoomId) ??
      (await t.app.realtime.getOrCreate(room.roomId as RoomId));
    if (!server) throw new Error('room did not load');
    // Fill the server's doc directly: only objects a socket touches are validated.
    server.doc.transact(() => {
      const objects = server.doc.getMap('objects');
      for (let i = 0; i < MAX_OBJECTS; i++)
        objects.set(`fill${String(i).padStart(8, '0')}`, new Y.Map());
    }, SERVER_ORIGIN);

    const evil = await evilEditor(room);
    evil.update((doc) => putObject(doc, 'over00000001', strokeFields()));
    await evil.waitFor(() => evil.errors().includes('object_limit'));
    await evil.waitFor(() => !objectsOf(evil.doc).has('over00000001'));
    expect(server.doc.getMap('objects').size).toBe(MAX_OBJECTS);
    expect(evil.socket.readyState).toBe(evil.socket.OPEN);
  });

  it('refuses new objects in a full room with a warning, and closes a socket that grows it otherwise with 4413', {
    timeout: 30_000,
  }, async () => {
    const room = await createRoom(t.app);
    const evil = await evilEditor(room);
    const server = t.app.realtime.get(room.roomId as RoomId);
    if (!server) throw new Error('room not loaded');
    // Past 5 MB in frames under the 256 KB cap, then a save measures it.
    for (let i = 0; i < 22; i++) {
      server.doc.transact(
        () => server.doc.getMap('meta').set(`blob${i}`, 'x'.repeat(250_000)),
        SERVER_ORIGIN,
      );
    }
    await server.saver.flush();
    expect(server.full).toBe(true);
    await evil.waitFor(() => evil.errors().includes('doc_limit'));

    evil.update((doc) => putObject(doc, 'full00000001', strokeFields()));
    await evil.waitFor(() => !objectsOf(evil.doc).has('full00000001'));
    expect(server.doc.getMap('objects').has('full00000001')).toBe(false);
    expect(evil.socket.readyState).toBe(evil.socket.OPEN);

    evil.update((doc) => doc.getMap('meta').set('more', 'y'.repeat(1000)));
    expect((await evil.closed).code).toBe(CloseCode.DocLimit);
  });

  it('closes socket 51 in a room with 4429', { timeout: 20_000 }, async () => {
    const room = await createRoom(t.app);
    for (let i = 0; i < MAX_SOCKETS_PER_ROOM; i++) await evilEditor(room);
    const extra = await EvilClient.connect(url, room.roomId);
    evils.push(extra);
    extra.hello(await tokens(room.roomId, room.editKey)());
    expect((await extra.closed).code).toBe(CloseCode.RateLimited);
    expect(extra.errors()).toEqual(['room_full']);
  });

  it('closes on a single update frame over 256 KB', async () => {
    const room = await createRoom(t.app);
    const evil = await evilEditor(room);
    evil.send(updateFrame(new Uint8Array(256 * 1024)));
    expect((await evil.closed).code).toBe(CloseCode.BadFrame);
  });
});

describe('lagging sockets', () => {
  it('stops sending awareness to a socket whose pongs fall behind, keeps its doc updates, and catches it up after', {
    timeout: 15_000,
  }, async () => {
    const room = await createRoom(t.app);
    const honest = client(room);
    await waitForStatus(honest, 'synced');
    const evil = await evilEditor(room);
    evil.answerPings = false;
    const awarenessSince = (from: number) =>
      evil.frames.slice(from).filter((f) => f.channel === 2).length;
    const cursor = setInterval(() => {
      honest.awareness.setLocalStateField('cursor', { x: Math.random(), y: 0.5 });
    }, 50);
    try {
      // Past the lag limit with pings unanswered: awareness stops, doc updates don't.
      await new Promise((resolve) => setTimeout(resolve, LAG_LIMIT_MS + 1500));
      const mark = evil.frames.length;
      honest.doc.transact(() => putObject(honest.doc, 'lagged000001', strokeFields()));
      await evil.waitFor(() => objectsOf(evil.doc).has('lagged000001'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(awarenessSince(mark)).toBe(0);

      // Answering again: the next pong is on time and awareness resumes.
      evil.answerPings = true;
      const resumed = evil.frames.length;
      await evil.waitFor(() => awarenessSince(resumed) > 0, 5000);
    } finally {
      clearInterval(cursor);
    }
  });
});

describe('SocketLimiter', () => {
  it('drops awareness over the limit but still lets Yjs frames through', () => {
    const limiter = new SocketLimiter(() => 0);
    for (let i = 0; i < 400; i++) expect(limiter.check('awareness', 10)).toBe('ok');
    expect(limiter.check('awareness', 10)).toBe('drop');
    expect(limiter.check('yjs', 10)).toBe('ok');
  });

  it('closes once Yjs frames have kept exceeding the limit for 2 s', () => {
    let now = 0;
    const limiter = new SocketLimiter(() => now);
    // 2,000 frames a second: ten times the limit. Refilled tokens let some through, which
    // must not count as the flood having stopped.
    let verdict = 'ok';
    while (verdict === 'ok' && now < 5000) {
      verdict = limiter.check('yjs', 10);
      now += 0.5;
    }
    expect(verdict).toBe('close');
    // The 400-frame burst covers the first ~200 ms; the 2 s count starts after it.
    expect(now).toBeGreaterThanOrEqual(2200);
    expect(now).toBeLessThan(2300);
  });

  it('does not count the first sync-2 against the byte budget', () => {
    const limiter = new SocketLimiter(() => 0);
    expect(limiter.check('sync2', 5 * 1024 * 1024)).toBe('ok');
    expect(limiter.check('yjs', 1000)).toBe('ok');
  });

  it('counts every later sync-2, so sending updates as sync-2 does not dodge the limit', () => {
    let now = 0;
    const limiter = new SocketLimiter(() => now);
    expect(limiter.check('sync2', 5 * 1024 * 1024)).toBe('ok');
    let verdict = 'ok';
    while (verdict === 'ok' && now < 5000) {
      now += 100;
      verdict = limiter.check('sync2', 1024 * 1024);
    }
    expect(verdict).toBe('close');
    expect(now).toBeLessThan(2500);
  });

  it('forgets a burst after a second without going over', () => {
    let now = 0;
    const limiter = new SocketLimiter(() => now);
    for (let i = 0; i < 401; i++) limiter.check('yjs', 10);
    now = 1500;
    expect(limiter.check('yjs', 10)).toBe('ok');
    // A new burst 2.5 s after the first starts its own 2 s window.
    now = 2500;
    for (let i = 0; i < 401; i++) expect(limiter.check('yjs', 10)).toBe('ok');
  });
});
