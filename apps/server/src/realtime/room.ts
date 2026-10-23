import {
  AwarenessType,
  awarenessFrame,
  Channel,
  CloseCode,
  type Frame,
  sync1Frame,
  sync2Frame,
  updateFrame,
  YjsType,
} from '@planted/protocol';
import type { RoomId, RoomRole } from '@planted/schema';
import type { FastifyBaseLogger } from 'fastify';
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { Connection, Inbound } from './connection';
import { MAX_DOC_BYTES, MAX_OBJECTS, MAX_SOCKETS_PER_ROOM, ROOM_LIMITS } from './limits';
import { DocSaver, type RoomStore } from './persistence';
import { allowedRoots, checkObject, ObjectTracker } from './validation';

export const UNLOAD_AFTER_MS = 60_000;

/** Origin of the server's own transactions: loading, compensating deletes. */
export const SERVER_ORIGIN = Symbol('planted.server');

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

/** What one socket's update did, collected while it is applied. */
type Held = {
  origin: Connection;
  /** The socket's own update(s), and the server's corrections, held back from broadcast. */
  updates: Uint8Array[];
  fixes: Uint8Array[];
  /** Root types the update changed anything under. */
  roots: Set<string>;
  /** New structs were integrated (not only deletions). */
  inserted: boolean;
};

/** Any shared type, as Yjs types the values of `doc.share`. */
type SharedType = Y.Doc['share'] extends Map<string, infer T> ? T : never;

/** The root type `type` sits under. */
function rootOf(type: SharedType): SharedType {
  let current = type;
  while (current._item) current = current._item.parent as SharedType;
  return current;
}

/** Deletes everything a root type holds, whatever kind of type it is. */
function clearRoot(root: SharedType, transaction: Y.Transaction): void {
  for (const item of root._map.values()) if (!item.deleted) item.delete(transaction);
  for (let item = root._start; item; item = item.right) if (!item.deleted) item.delete(transaction);
}

export type RoomOptions = {
  id: RoomId;
  epoch: number;
  /** Encoded state from Postgres, applied before anyone gets `welcome`. */
  state: Uint8Array | null;
  store: RoomStore;
  log: FastifyBaseLogger;
  /** Allows the dev-only root types. */
  dev: boolean;
  onIdle: (room: Room) => void;
  /** The room's row was deleted while it was loaded; the manager drops it. */
  onGone: (room: Room) => void;
};

/**
 * One room in memory: the doc, presence, and the sockets in it. The doc here is the source of
 * truth while the room is loaded; `DocSaver` copies it to Postgres.
 *
 * CRDT updates can't be rejected once applied, so every update from a socket is applied, then
 * the objects it touched are validated; anything invalid is deleted again in a `SERVER_ORIGIN`
 * transaction. Broadcasts are held back while that happens, so other sockets get the update and
 * its correction as one frame and never see the bad object.
 */
export class Room {
  readonly id: RoomId;
  readonly epoch: number;
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new Awareness(this.doc);
  readonly conns = new Set<Connection>();
  readonly saver: DocSaver;
  readonly log: FastifyBaseLogger;

  #unloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** One socket's update while it is applied and checked. */
  #held: Held | null = null;
  readonly #objects: Y.Map<unknown>;
  readonly #tracker: ObjectTracker;
  readonly #roots: ReadonlySet<string>;
  readonly #onIdle: (room: Room) => void;
  readonly #onGone: (room: Room) => void;
  /** Over the doc-size limit: new objects are refused until something goes. */
  #full = false;
  /**
   * The encoded doc size: exact at load and at every save, plus the bytes of every update since.
   * Deletes make it overestimate, which only means the exact check at the next save corrects it.
   */
  #approxBytes = 0;
  #closed = false;

  constructor({ id, epoch, state, store, log, dev, onIdle, onGone }: RoomOptions) {
    this.id = id;
    this.epoch = epoch;
    this.log = log.child({ roomId: id });
    this.#onIdle = onIdle;
    this.#onGone = onGone;
    this.#roots = allowedRoots(dev);
    // The server is a relay, not a user: it must never show up in anyone's peer list.
    this.awareness.setLocalState(null);
    this.#objects = this.doc.getMap('objects');
    if (state) Y.applyUpdate(this.doc, state, SERVER_ORIGIN);
    this.#approxBytes = state?.byteLength ?? 0;
    this.#full = this.#approxBytes > MAX_DOC_BYTES;
    this.#tracker = new ObjectTracker(this.#objects, (origin) => origin === this.#held?.origin);
    this.saver = new DocSaver({
      save: () => this.#save(store),
      log: this.log,
    });
    this.doc.on('update', this.#onDocUpdate);
    this.doc.on('afterTransaction', this.#onAfterTransaction);
    this.awareness.on('update', this.#onAwarenessUpdate);
  }

  get docBytes(): number {
    return Y.encodeStateAsUpdate(this.doc).byteLength;
  }

  get full(): boolean {
    return this.#full;
  }

  /** Sends `welcome` (answering `helloSeq`) and starts the sync. False if the room is full. */
  join(conn: Connection, role: RoomRole, helloSeq: number): boolean {
    if (this.#closed) {
      // Cleared or shut down between the load and this join: the client simply reconnects.
      conn.close(CloseCode.GoingAway, 'room_reloading');
      return false;
    }
    if (this.conns.size >= MAX_SOCKETS_PER_ROOM) {
      conn.fail(CloseCode.RateLimited, 'room_full', 'This room has too many people in it');
      return false;
    }
    if (this.#unloadTimer) clearTimeout(this.#unloadTimer);
    this.#unloadTimer = null;
    conn.role = role;
    this.conns.add(conn);
    conn.onClose((code) => this.#leave(conn, code));
    conn.log.info({ roomId: this.id, role, conns: this.conns.size }, 'conn.open');
    conn.sendControl({
      kind: 'welcome',
      seq: helloSeq,
      body: { role, roomEpoch: this.epoch, serverTime: Date.now(), limits: ROOM_LIMITS },
    });
    // A viewer's state is never needed: it can't contribute anything.
    if (role === 'edit') conn.send(sync1Frame(this.doc));
    if (this.#full && role === 'edit') this.#sendDocLimit(conn);
    // Presence frames skipped while the socket lagged are stale anyway; one snapshot replaces them.
    conn.onCaughtUp(() => {
      const others = [...this.awareness.getStates().keys()].filter((id) => !conn.clientIds.has(id));
      if (others.length > 0) conn.send(awarenessFrame(this.awareness, others), { droppable: true });
    });
    conn.setHandler((inbound) => this.#onInbound(conn, inbound));
    return true;
  }

  /** Closes every socket with `code`; the room itself stays loaded. */
  disconnectAll(code: number, reason: string): void {
    for (const conn of [...this.conns]) conn.close(code, reason);
  }

  /** Schedules the idle check again, e.g. after an unload was refused because of unsaved work. */
  scheduleIdleCheck(): void {
    if (this.#closed || this.conns.size > 0) return;
    if (this.#unloadTimer) clearTimeout(this.#unloadTimer);
    this.#unloadTimer = setTimeout(() => this.#onIdle(this), UNLOAD_AFTER_MS);
  }

  /** Refuses joins (they're told to retry) until `reopen`; set before any await in a clear. */
  close(): void {
    this.#closed = true;
    if (this.#unloadTimer) clearTimeout(this.#unloadTimer);
    this.#unloadTimer = null;
  }

  /** Undoes `close` after a clear that failed: the room carries on with its doc. */
  reopen(): void {
    this.#closed = false;
    this.scheduleIdleCheck();
  }

  /** Sockets still open keep their connection, but closing them no longer touches the room. */
  destroy(): void {
    this.close();
    this.conns.clear();
    if (this.#unloadTimer) clearTimeout(this.#unloadTimer);
    this.#unloadTimer = null;
    void this.saver.stop();
    this.#tracker.destroy();
    this.doc.off('update', this.#onDocUpdate);
    this.doc.off('afterTransaction', this.#onAfterTransaction);
    this.awareness.off('update', this.#onAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }

  async #save(store: RoomStore): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.doc);
    if ((await store.save(this.id, state)) === 'gone') {
      this.log.warn('room.gone: deleted while loaded');
      this.close();
      for (const conn of [...this.conns]) {
        conn.fail(CloseCode.RoomNotFound, 'room_not_found', 'This board no longer exists');
      }
      this.#onGone(this);
      return;
    }
    this.#approxBytes = state.byteLength;
    this.#setFull(state.byteLength > MAX_DOC_BYTES);
  }

  #setFull(full: boolean): void {
    if (full === this.#full) return;
    this.#full = full;
    this.log.warn({ approxBytes: this.#approxBytes, full }, 'room.doc_limit');
    if (full) for (const conn of this.conns) if (conn.role === 'edit') this.#sendDocLimit(conn);
  }

  #sendDocLimit(conn: Connection): void {
    conn.sendError({
      code: 'doc_limit',
      message: 'This board is full. Delete something to keep drawing.',
      fatal: false,
    });
  }

  #leave(conn: Connection, code: number): void {
    const wasMember = this.conns.delete(conn);
    conn.log.info({ roomId: this.id, conns: this.conns.size, code }, 'conn.close');
    if (!wasMember) return;
    // Ghost cursors vanish now rather than after the 30 s awareness timeout.
    removeAwarenessStates(this.awareness, [...conn.clientIds], null);
    this.scheduleIdleCheck();
  }

  #onInbound(conn: Connection, inbound: Inbound): void {
    if (inbound.channel === 'control') {
      if (inbound.message.kind === 'hello') {
        conn.fail(CloseCode.BadFrame, 'unexpected_hello', 'Already welcomed');
      }
      // pong and anything else from the client is ignored once joined.
      return;
    }
    this.#onFrame(conn, inbound.frame);
  }

  #onFrame(conn: Connection, frame: Exclude<Frame, { channel: 0 }>): void {
    switch (frame.channel) {
      case Channel.Awareness:
        if (frame.type === AwarenessType.Update) this.#applyAwareness(conn, frame.payload);
        return;
      case Channel.App:
        // ping-map (0.6) and kick (0.7) get handlers later; nothing is relayed yet.
        return;
      case Channel.Yjs:
        break;
    }
    switch (frame.type) {
      case YjsType.Sync1: {
        conn.send(sync2Frame(this.doc, frame.payload));
        const others = [...this.awareness.getStates().keys()].filter(
          (id) => !conn.clientIds.has(id),
        );
        if (others.length > 0) conn.send(awarenessFrame(this.awareness, others));
        break;
      }
      case YjsType.Sync2:
      case YjsType.Update:
        if (conn.role !== 'edit') {
          conn.log.warn({ roomId: this.id }, 'viewer sent a doc update');
          conn.fail(CloseCode.Forbidden, 'forbidden', 'View-only link');
          return;
        }
        this.#applyUpdate(conn, frame.payload);
        break;
    }
  }

  #applyUpdate(conn: Connection, update: Uint8Array): void {
    const held: Held = { origin: conn, updates: [], fixes: [], roots: new Set(), inserted: false };
    this.#held = held;
    let decodeError: unknown = null;
    try {
      Y.applyUpdate(this.doc, update, conn);
    } catch (err) {
      // Yjs integrates the structs before it reads the delete set, so a malformed update can
      // throw with part of it already in the doc. Everything below runs either way.
      decodeError = err;
    }
    const { touched, added } = this.#tracker.take();
    this.#approxBytes += update.byteLength;

    const unknownRoots = [...held.roots].filter((name) => !this.#roots.has(name));
    const invalid = [...touched].flatMap((id) => {
      const value = this.#objects.get(id);
      // Gone again by the end of the transaction (or a delete): nothing to check.
      if (value === undefined) return [];
      return checkObject(id, value) ?? [];
    });
    const remove = new Set(invalid.map((i) => i.id));
    let warning: 'object_limit' | 'doc_limit' | null = null;
    const fresh = [...added].filter((id) => this.#objects.has(id) && !remove.has(id));
    if (fresh.length > 0 && this.#full) warning = 'doc_limit';
    else if (fresh.length > 0 && this.#objects.size > MAX_OBJECTS) warning = 'object_limit';
    if (warning) for (const id of fresh) remove.add(id);
    // While full, growing anything but a new object (which is removed above) can't be undone
    // cleanly, so the sender is closed: at most one frame per connection gets through.
    const growsFullDoc = this.#full && held.inserted && fresh.length === 0;

    if (remove.size > 0 || unknownRoots.length > 0) {
      this.doc.transact((transaction) => {
        for (const id of remove) this.#objects.delete(id);
        for (const name of unknownRoots) {
          const root = this.doc.share.get(name);
          if (root) clearRoot(root, transaction);
        }
      }, SERVER_ORIGIN);
    }
    this.#held = null;

    // The others get the update and its correction as one frame. The sender gets only the
    // correction, unless it is about to be closed.
    const all = [...held.updates, ...held.fixes];
    if (all.length > 0) {
      const merged = all.length === 1 ? (all[0] as Uint8Array) : Y.mergeUpdates(all);
      this.#broadcast(updateFrame(merged), conn);
    }

    if (decodeError) {
      conn.log.warn({ roomId: this.id, err: decodeError, ids: [...remove] }, 'bad update');
      conn.fail(CloseCode.BadFrame, 'bad_update', 'Update does not decode');
      return;
    }
    if (invalid.length > 0 || unknownRoots.length > 0) {
      conn.log.warn(
        { roomId: this.id, ids: invalid.map((i) => i.id), issues: invalid, unknownRoots },
        'invalid update',
      );
      conn.fail(
        CloseCode.BadFrame,
        'invalid_object',
        unknownRoots.length > 0 ? `Unknown root type ${unknownRoots[0]}` : 'Invalid board object',
      );
      return;
    }
    if (growsFullDoc) {
      conn.log.warn({ roomId: this.id }, 'update grew a full doc');
      conn.fail(CloseCode.DocLimit, 'doc_limit', 'This board is full. Delete something first.');
      return;
    }
    if (warning) {
      for (const fix of held.fixes) conn.send(updateFrame(fix));
      conn.sendError({
        code: warning,
        message:
          warning === 'doc_limit'
            ? 'This board is full. Delete something to keep drawing.'
            : `A board holds at most ${MAX_OBJECTS} objects.`,
        fatal: false,
      });
    }
    if (this.#approxBytes > MAX_DOC_BYTES) this.#setFull(true);
  }

  #applyAwareness(conn: Connection, payload: Uint8Array): void {
    try {
      applyAwarenessUpdate(this.awareness, payload, conn);
    } catch (err) {
      conn.log.warn({ roomId: this.id, err }, 'bad awareness update');
      conn.fail(CloseCode.BadFrame, 'bad_update', 'Awareness update does not decode');
    }
  }

  #onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // The state loaded from Postgres is applied before this listener exists, so every update
    // here is new.
    this.saver.markDirty();
    const held = this.#held;
    if (held) {
      if (origin === held.origin) held.updates.push(update);
      else held.fixes.push(update);
      return;
    }
    this.#broadcast(updateFrame(update), origin);
  };

  #onAfterTransaction = (transaction: Y.Transaction): void => {
    const held = this.#held;
    if (!held || transaction.origin !== held.origin) return;
    for (const type of transaction.changed.keys()) {
      const root = rootOf(type);
      for (const [name, shared] of this.doc.share) if (shared === root) held.roots.add(name);
    }
    for (const [client, clock] of transaction.afterState) {
      if (clock > (transaction.beforeState.get(client) ?? 0)) held.inserted = true;
    }
  };

  #onAwarenessUpdate = ({ added, updated, removed }: AwarenessChange, origin: unknown): void => {
    const owner = this.conns.has(origin as Connection) ? (origin as Connection) : undefined;
    if (owner) {
      for (const id of [...added, ...updated]) owner.clientIds.add(id);
    }
    for (const id of removed) for (const conn of this.conns) conn.clientIds.delete(id);
    const changed = [...added, ...updated, ...removed];
    if (changed.length === 0) return;
    const bytes = awarenessFrame(this.awareness, changed);
    for (const conn of this.conns) {
      if (conn !== origin) conn.send(bytes, { droppable: true });
    }
  };

  #broadcast(bytes: Uint8Array, except: unknown): void {
    for (const conn of this.conns) {
      if (conn !== except) conn.send(bytes);
    }
  }
}
