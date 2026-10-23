import {
  AwarenessType,
  awarenessFrame,
  Channel,
  type Frame,
  sync1Frame,
  sync2Frame,
  updateFrame,
  YjsType,
} from '@planted/protocol';
import type { RoomId } from '@planted/schema';
import type { FastifyBaseLogger } from 'fastify';
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { CloseCode, type Connection } from './connection';

export const UNLOAD_AFTER_MS = 60_000;

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };

/**
 * One room in memory: the doc, presence, and the sockets in it. State lives only here in 0.2;
 * when the room unloads (or the process restarts) the clients still have the doc and upload it
 * again on their next handshake.
 */
export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new Awareness(this.doc);
  readonly conns = new Set<Connection>();

  #unloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Broadcasts held back while an update is being applied, so a bad one sends nothing. */
  #held: { frames: Uint8Array[]; origin: unknown } | null = null;

  constructor(
    readonly id: RoomId,
    readonly log: FastifyBaseLogger,
    readonly onIdle: (room: Room) => void,
  ) {
    // The server is a relay, not a user: it must never show up in anyone's peer list.
    this.awareness.setLocalState(null);
    this.doc.on('update', this.#onDocUpdate);
    this.awareness.on('update', this.#onAwarenessUpdate);
  }

  get docBytes(): number {
    return Y.encodeStateAsUpdate(this.doc).byteLength;
  }

  join(conn: Connection): void {
    if (this.#unloadTimer) clearTimeout(this.#unloadTimer);
    this.#unloadTimer = null;
    this.conns.add(conn);
    conn.onClose((code) => this.#leave(conn, code));
    conn.log.info({ roomId: this.id, conns: this.conns.size }, 'conn.open');
    conn.send(sync1Frame(this.doc));
    conn.attach((frame) => this.#onFrame(conn, frame));
  }

  /** Sockets still open keep their connection, but closing them no longer touches the room. */
  destroy(): void {
    this.conns.clear();
    if (this.#unloadTimer) clearTimeout(this.#unloadTimer);
    this.#unloadTimer = null;
    this.doc.off('update', this.#onDocUpdate);
    this.awareness.off('update', this.#onAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }

  #leave(conn: Connection, code: number): void {
    const wasMember = this.conns.delete(conn);
    conn.log.info({ roomId: this.id, conns: this.conns.size, code }, 'conn.close');
    if (!wasMember) return;
    // Ghost cursors vanish now rather than after the 30 s awareness timeout.
    removeAwarenessStates(this.awareness, [...conn.clientIds], null);
    if (this.conns.size === 0) {
      this.#unloadTimer = setTimeout(() => this.onIdle(this), UNLOAD_AFTER_MS);
    }
  }

  #onFrame(conn: Connection, frame: Frame): void {
    if (frame.channel === Channel.Awareness) {
      if (frame.type === AwarenessType.Update) this.#applyAwareness(conn, frame.payload);
      return;
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
        this.#applyUpdate(conn, frame.payload);
        break;
    }
  }

  #applyUpdate(conn: Connection, update: Uint8Array): void {
    this.#held = { frames: [], origin: conn };
    try {
      Y.applyUpdate(this.doc, update, conn);
    } catch (err) {
      this.#held = null;
      conn.log.warn({ roomId: this.id, err }, 'bad update');
      conn.close(CloseCode.BadUpdate, 'bad_update');
      return;
    }
    const { frames } = this.#held;
    this.#held = null;
    for (const bytes of frames) this.#broadcast(bytes, conn);
  }

  #applyAwareness(conn: Connection, payload: Uint8Array): void {
    try {
      applyAwarenessUpdate(this.awareness, payload, conn);
    } catch (err) {
      conn.log.warn({ roomId: this.id, err }, 'bad awareness update');
      conn.close(CloseCode.BadUpdate, 'bad_update');
    }
  }

  #onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    const bytes = updateFrame(update);
    if (this.#held && this.#held.origin === origin) this.#held.frames.push(bytes);
    else this.#broadcast(bytes, origin);
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
