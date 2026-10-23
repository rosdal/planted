import type { LiveStroke, ObjectsMap } from '@planted/client';
import { Container, Graphics } from 'pixi.js';
import type { Awareness } from 'y-protocols/awareness';
import { drawStrokePath } from './stroke';

/** Past this many points, the live stroke freezes what it has and only redraws the tail. */
const CHUNK_POINTS = 500;
/** Most points accepted from a peer's live stroke (the sender caps at 1,000). */
const MAX_REMOTE_POINTS = 2000;
/**
 * How long a peer's live stroke stays after its awareness `live` went null. The commit usually
 * lands first (same tick, same socket), but if the awareness frame wins the race the stroke
 * would blink out for a frame; this bridges it. A cancelled stroke fades after this too.
 */
const LINGER_MS = 1000;

/**
 * Your own in-progress stroke, drawn every frame from the pen's local buffer: no network in the
 * loop, so it is under the pointer at once. Long strokes are split into frozen chunks so a frame
 * only re-tessellates the last few hundred points.
 */
export class LocalLiveStroke {
  readonly container = new Container({ label: 'localLive' });
  #points: readonly number[] = [];
  #colour = '#ffffff';
  #width = 0.002;
  #drawnCount = 0;
  /** Point index where the tail starts; everything before it sits in frozen chunks. */
  #tailStart = 0;
  #tail: Graphics | null = null;

  begin(colour: string, width: number, points: readonly number[]): void {
    this.clear();
    this.#colour = colour;
    this.#width = width;
    this.#points = points;
  }

  get active(): boolean {
    return this.#points.length > 0;
  }

  /** Called once a frame; redraws only when the pen added points. */
  render(): void {
    const count = this.#points.length >> 1;
    if (count === this.#drawnCount) return;
    this.#drawnCount = count;
    if (count - this.#tailStart > CHUNK_POINTS && this.#tail) {
      // Freeze the current tail as is and start a new one from its last point.
      this.#tail = null;
      this.#tailStart = count - 1;
    }
    if (!this.#tail) {
      this.#tail = new Graphics();
      this.container.addChild(this.#tail);
    }
    this.#tail.clear();
    drawStrokePath(
      this.#tail,
      this.#points.slice(this.#tailStart * 2, count * 2),
      this.#width,
      this.#colour,
    );
  }

  clear(): void {
    for (const child of this.container.removeChildren()) child.destroy();
    this.#points = [];
    this.#drawnCount = 0;
    this.#tailStart = 0;
    this.#tail = null;
  }
}

type RemoteLive = { id: string; graphics: Graphics; goneAt: number | null };

function parseLive(value: unknown): LiveStroke | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, colour, width, points } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(colour)) {
    return null;
  }
  if (typeof width !== 'number' || !(width > 0 && width <= 0.02)) return null;
  if (!Array.isArray(points) || points.length > MAX_REMOTE_POINTS) return null;
  if (!points.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { id, colour, width, points };
}

/**
 * Other users' in-progress strokes, from their awareness `live` field. A live stroke whose id
 * is already in `objects` is skipped, so the committed version replaces it with no double
 * drawing and no flicker.
 */
export class RemoteLiveStrokes {
  readonly container = new Container({ label: 'remoteLive' });
  readonly #byClient = new Map<number, RemoteLive>();
  readonly #dirty = new Set<number>();
  readonly #awareness: Awareness;
  readonly #objects: ObjectsMap;

  constructor(awareness: Awareness, objects: ObjectsMap) {
    this.#awareness = awareness;
    this.#objects = objects;
    awareness.on('change', this.#onChange);
    for (const clientId of awareness.getStates().keys()) this.#dirty.add(clientId);
  }

  get size(): number {
    return this.#byClient.size;
  }

  /** Called once a frame, after the scene store flushed this frame's commits. */
  render(now: number): void {
    for (const clientId of this.#dirty) this.#apply(clientId, now);
    this.#dirty.clear();
    for (const [clientId, live] of this.#byClient) {
      const committed = this.#objects.has(live.id);
      if (committed || (live.goneAt !== null && now - live.goneAt > LINGER_MS)) {
        live.graphics.destroy();
        this.#byClient.delete(clientId);
      }
    }
  }

  destroy(): void {
    this.#awareness.off('change', this.#onChange);
    this.container.destroy({ children: true });
    this.#byClient.clear();
  }

  #apply(clientId: number, now: number): void {
    if (clientId === this.#awareness.clientID) return;
    const state = this.#awareness.getStates().get(clientId);
    const live = parseLive(state?.live);
    const existing = this.#byClient.get(clientId);
    if (!live || this.#objects.has(live.id)) {
      if (existing && existing.goneAt === null) existing.goneAt = now;
      return;
    }
    let entry = existing;
    if (!entry || entry.id !== live.id) {
      entry?.graphics.destroy();
      entry = { id: live.id, graphics: new Graphics(), goneAt: null };
      this.container.addChild(entry.graphics);
      this.#byClient.set(clientId, entry);
    }
    entry.goneAt = null;
    entry.graphics.clear();
    drawStrokePath(entry.graphics, live.points, live.width, live.colour);
  }

  #onChange = ({
    added,
    updated,
    removed,
  }: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void => {
    for (const id of added) this.#dirty.add(id);
    for (const id of updated) this.#dirty.add(id);
    for (const id of removed) this.#dirty.add(id);
  };
}
