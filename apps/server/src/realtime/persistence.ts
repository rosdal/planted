import { type Db, roomDocs, rooms } from '@planted/db';
import type { RoomId } from '@planted/schema';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import * as Y from 'yjs';

/** Debounce after the last update. */
export const SAVE_DEBOUNCE_MS = 2000;
/** A room that never goes quiet still saves this often. */
export const SAVE_MAX_WAIT_MS = 10_000;
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;

/** 1 s, 2 s, 4 s … capped at 30 s. `failures` counts from 1. */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1));
}

export type LoadedRoom = { ydoc: Uint8Array | null; epoch: number };

/**
 * Where docs survive restarts. The doc in memory is the source of truth while a room is loaded;
 * this is the copy. An interface so tests can stub a failing database.
 */
export interface RoomStore {
  /**
   * Null when the room doesn't exist (never created, or expired). Loading counts as activity
   * for the 30-day expiry, so a board that is only ever viewed stays.
   */
  load(roomId: RoomId): Promise<LoadedRoom | null>;
  /**
   * Full state, not increments: one row per room, upserted. `gone` when the room row was
   * deleted underneath a loaded room (another instance's expiry job): there is nothing to save
   * it into, and retrying would never succeed.
   */
  save(roomId: RoomId, state: Uint8Array): Promise<'saved' | 'gone'>;
  /** Replaces the doc with an empty one and bumps the epoch; returns the new epoch. */
  clear(roomId: RoomId): Promise<number>;
}

const EMPTY_DOC = Y.encodeStateAsUpdate(new Y.Doc());

export class PgRoomStore implements RoomStore {
  constructor(private readonly db: Db) {}

  async load(roomId: RoomId): Promise<LoadedRoom | null> {
    const [room] = await this.db
      .update(rooms)
      .set({ lastActiveAt: sql`now()` })
      .where(eq(rooms.id, roomId))
      .returning({ epoch: rooms.epoch });
    if (!room) return null;
    const [doc] = await this.db
      .select({ ydoc: roomDocs.ydoc })
      .from(roomDocs)
      .where(eq(roomDocs.roomId, roomId));
    return { epoch: room.epoch, ydoc: doc?.ydoc ?? null };
  }

  async save(roomId: RoomId, state: Uint8Array): Promise<'saved' | 'gone'> {
    return this.db.transaction(async (tx) => {
      // Locks the room row, so an expiry can't delete it between this check and the upsert.
      const [room] = await tx
        .update(rooms)
        .set({ lastActiveAt: sql`now()` })
        .where(eq(rooms.id, roomId))
        .returning({ id: rooms.id });
      if (!room) return 'gone' as const;
      await tx
        .insert(roomDocs)
        .values({ roomId, ydoc: state, version: 1 })
        .onConflictDoUpdate({
          target: roomDocs.roomId,
          set: { ydoc: state, version: sql`${roomDocs.version} + 1`, updatedAt: sql`now()` },
        });
      return 'saved' as const;
    });
  }

  async clear(roomId: RoomId): Promise<number> {
    return this.db.transaction(async (tx) => {
      const [room] = await tx
        .update(rooms)
        .set({ epoch: sql`${rooms.epoch} + 1`, lastActiveAt: sql`now()` })
        .where(eq(rooms.id, roomId))
        .returning({ epoch: rooms.epoch });
      if (!room) throw new Error(`room ${roomId} not found`);
      await tx
        .insert(roomDocs)
        .values({ roomId, ydoc: EMPTY_DOC, version: 1 })
        .onConflictDoUpdate({
          target: roomDocs.roomId,
          set: { ydoc: EMPTY_DOC, version: sql`${roomDocs.version} + 1`, updatedAt: sql`now()` },
        });
      return room.epoch;
    });
  }
}

export type DocSaverOptions = {
  /** Writes the current state; throws on failure. */
  save: () => Promise<void>;
  log: FastifyBaseLogger;
  /** Called whenever `failing` changes, for the debug page. */
  onFailingChange?: (failing: boolean) => void;
};

/**
 * When to save one room: 2 s after the last update, but at least every 10 s while updates keep
 * coming. Never two saves at once: an update during a save marks the room dirty again, and the
 * next save is scheduled once this one finishes. A failed save retries with backoff and keeps
 * `dirty` set, which keeps the room loaded.
 */
export class DocSaver {
  #dirty = false;
  #dirtySince: number | null = null;
  #saving: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #failures = 0;
  #stopped = false;
  readonly #options: DocSaverOptions;

  constructor(options: DocSaverOptions) {
    this.#options = options;
  }

  /** Unsaved changes, including ones whose save is failing. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** The last save failed and a retry is pending. */
  get failing(): boolean {
    return this.#failures > 0;
  }

  markDirty(): void {
    if (this.#stopped) return;
    this.#dirty = true;
    this.#dirtySince ??= Date.now();
    // While retrying, the retry timer owns the schedule; while saving, `#run` reschedules.
    if (this.#saving || this.failing) return;
    this.#schedule();
  }

  /**
   * Save now if dirty and wait for it. True when everything is saved; false when a save failed
   * (the retry timer keeps going) or the saver was stopped.
   */
  async flush(): Promise<boolean> {
    while (!this.#stopped) {
      if (this.#saving) {
        await this.#saving;
        continue;
      }
      if (!this.#dirty) return true;
      const failuresBefore = this.#failures;
      await this.#run();
      if (this.#failures > failuresBefore) return false;
    }
    return !this.#dirty;
  }

  /** Stops scheduling; an in-flight save still finishes. Resolves once nothing is in flight. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearTimer();
    if (this.#saving) await this.#saving;
  }

  #schedule(): void {
    this.#clearTimer();
    const sinceDirty = Date.now() - (this.#dirtySince ?? Date.now());
    const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - sinceDirty));
    this.#timer = setTimeout(() => void this.#run(), delay);
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #run(): Promise<void> {
    if (this.#saving) return this.#saving;
    this.#clearTimer();
    this.#dirty = false;
    this.#dirtySince = null;
    const run = (async () => {
      try {
        await this.#options.save();
        if (this.#failures > 0) {
          this.#options.log.info({ failures: this.#failures }, 'room.save_recovered');
          this.#failures = 0;
          this.#options.onFailingChange?.(false);
        }
      } catch (err) {
        this.#dirty = true;
        this.#dirtySince ??= Date.now();
        this.#failures++;
        const retryMs = retryDelay(this.#failures);
        this.#options.log.error({ err, failures: this.#failures, retryMs }, 'room.save_failed');
        if (this.#failures === 1) this.#options.onFailingChange?.(true);
        if (!this.#stopped) this.#timer = setTimeout(() => void this.#run(), retryMs);
        return;
      } finally {
        this.#saving = null;
      }
      if (this.#dirty && !this.#stopped) this.#schedule();
    })();
    this.#saving = run;
    return run;
  }
}
