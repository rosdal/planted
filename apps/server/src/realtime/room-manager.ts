import type { RoomId } from '@planted/schema';
import type { FastifyBaseLogger } from 'fastify';
import { CloseCode } from './connection';
import { Room } from './room';

export type RealtimeStats = {
  rooms: { roomId: RoomId; conns: number; docBytes: number }[];
  conns: number;
};

export class RoomManager {
  readonly #rooms = new Map<RoomId, Room>();

  constructor(readonly log: FastifyBaseLogger) {}

  get(roomId: RoomId): Room | undefined {
    return this.#rooms.get(roomId);
  }

  getOrCreate(roomId: RoomId): Room {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, this.log, (idle) => this.unload(idle));
      this.#rooms.set(roomId, room);
      this.log.info({ roomId, rooms: this.#rooms.size }, 'room.loaded');
    }
    return room;
  }

  unload(room: Room): void {
    if (this.#rooms.get(room.id) !== room) return;
    this.#rooms.delete(room.id);
    room.destroy();
    this.log.info({ roomId: room.id, rooms: this.#rooms.size }, 'room.unloaded');
  }

  stats(): RealtimeStats {
    const rooms = [...this.#rooms.values()].map((room) => ({
      roomId: room.id,
      conns: room.conns.size,
      docBytes: room.docBytes,
    }));
    return { rooms, conns: rooms.reduce((sum, room) => sum + room.conns, 0) };
  }

  /** Shutdown: tell every client to reconnect elsewhere (or later), then drop the rooms. */
  closeAll(): void {
    for (const room of this.#rooms.values()) {
      const conns = [...room.conns];
      room.destroy();
      for (const conn of conns) conn.close(CloseCode.GoingAway, 'going_away');
    }
    this.#rooms.clear();
  }
}
