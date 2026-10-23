import { CloseCode } from '@planted/protocol';
import type { RoomId } from '@planted/schema';
import type { FastifyBaseLogger } from 'fastify';
import type { RoomStore } from './persistence';
import { Room } from './room';

/** Shutdown waits this long for every dirty room to save before giving up on the rest. */
export const SHUTDOWN_FLUSH_MS = 10_000;

export type RealtimeStats = {
  rooms: { roomId: RoomId; conns: number; docBytes: number; unsaved: boolean }[];
  conns: number;
};

export type RoomManagerOptions = { store: RoomStore; log: FastifyBaseLogger; dev: boolean };

export class RoomManager {
  readonly #rooms = new Map<RoomId, Room>();
  /** Loads (and clears) in flight, so concurrent joins to a cold room share one load. */
  readonly #pending = new Map<RoomId, Promise<unknown>>();
  readonly #store: RoomStore;
  readonly #dev: boolean;
  readonly log: FastifyBaseLogger;

  constructor({ store, log, dev }: RoomManagerOptions) {
    this.#store = store;
    this.log = log;
    this.#dev = dev;
  }

  get(roomId: RoomId): Room | undefined {
    return this.#rooms.get(roomId);
  }

  loadedIds(): RoomId[] {
    return [...this.#rooms.keys()];
  }

  /**
   * The loaded room, or load it from Postgres first. Null when the room doesn't exist.
   * Single-flight: every caller during a load awaits the same promise.
   */
  async getOrCreate(roomId: RoomId): Promise<Room | null> {
    for (;;) {
      const room = this.#rooms.get(roomId);
      if (room) return room;
      const pending = this.#pending.get(roomId);
      if (!pending) break;
      await pending.catch(() => {});
    }
    const load = this.#load(roomId);
    this.#pending.set(roomId, load);
    try {
      return await load;
    } finally {
      this.#pending.delete(roomId);
    }
  }

  async #load(roomId: RoomId): Promise<Room | null> {
    const start = performance.now();
    const loaded = await this.#store.load(roomId);
    if (!loaded) return null;
    const room = new Room({
      id: roomId,
      epoch: loaded.epoch,
      state: loaded.ydoc,
      store: this.#store,
      log: this.log,
      dev: this.#dev,
      onIdle: (idle) => void this.unload(idle),
    });
    this.#rooms.set(roomId, room);
    this.log.info(
      {
        roomId,
        bytes: loaded.ydoc?.byteLength ?? 0,
        ms: Math.round(performance.now() - start),
        rooms: this.#rooms.size,
      },
      'room.loaded',
    );
    return room;
  }

  /**
   * Unloads an idle room once its last changes are saved. A room whose save is failing stays
   * loaded, and tries again later, so nothing is lost.
   */
  async unload(room: Room): Promise<void> {
    if (this.#rooms.get(room.id) !== room || room.conns.size > 0) return;
    const saved = await room.saver.flush();
    // Someone may have joined while the save ran.
    if (this.#rooms.get(room.id) !== room || room.conns.size > 0) return;
    if (!saved) {
      this.log.warn({ roomId: room.id }, 'room.unload_deferred: unsaved changes');
      room.scheduleIdleCheck();
      return;
    }
    this.#rooms.delete(room.id);
    room.destroy();
    this.log.info({ roomId: room.id, rooms: this.#rooms.size }, 'room.unloaded');
  }

  /** Closes every socket in the room with `code`, if it's loaded. */
  disconnectAll(roomId: RoomId, code: number, reason: string): void {
    this.#rooms.get(roomId)?.disconnectAll(code, reason);
  }

  /**
   * Empties the room's doc and bumps its epoch: sockets close with 4409, the loaded doc is
   * dropped without a final save, and the next join loads the empty doc. Returns the new epoch.
   */
  async clear(roomId: RoomId): Promise<number> {
    while (this.#pending.has(roomId)) await this.#pending.get(roomId)?.catch(() => {});
    const run = (async () => {
      const room = this.#rooms.get(roomId);
      if (room) {
        this.#rooms.delete(roomId);
        room.disconnectAll(CloseCode.EpochChanged, 'epoch_changed');
        // A save already running finishes before the clear overwrites it, never after.
        await room.saver.stop();
        room.destroy();
      }
      const epoch = await this.#store.clear(roomId);
      this.log.info({ roomId, epoch }, 'room.cleared');
      return epoch;
    })();
    this.#pending.set(roomId, run);
    try {
      return await run;
    } finally {
      this.#pending.delete(roomId);
    }
  }

  stats(): RealtimeStats {
    const rooms = [...this.#rooms.values()].map((room) => ({
      roomId: room.id,
      conns: room.conns.size,
      docBytes: room.docBytes,
      unsaved: room.saver.failing,
    }));
    return { rooms, conns: rooms.reduce((sum, room) => sum + room.conns, 0) };
  }

  /**
   * Shutdown: tell every client to reconnect elsewhere (or later), then save every dirty room
   * in parallel, giving up after 10 s overall. Rooms that didn't make it are logged.
   */
  async closeAll(): Promise<void> {
    const rooms = [...this.#rooms.values()];
    for (const room of rooms) room.disconnectAll(CloseCode.GoingAway, 'going_away');
    const dirty = rooms.filter((room) => room.saver.dirty);
    const unsaved = new Set(dirty.map((room) => room.id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(
        dirty.map(async (room) => {
          if (await room.saver.flush()) unsaved.delete(room.id);
        }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_FLUSH_MS);
      }),
    ]);
    clearTimeout(timer);
    if (unsaved.size > 0) {
      this.log.error({ rooms: [...unsaved] }, 'shutdown: rooms not saved');
    } else if (dirty.length > 0) {
      this.log.info({ rooms: dirty.length }, 'shutdown: rooms saved');
    }
    for (const room of rooms) room.destroy();
    this.#rooms.clear();
  }
}
