import {
  base62Id,
  MAX_STROKE_POINTS,
  OBJECT_ID_BYTES,
  OBJECT_ID_LENGTH,
  StrokeObject,
} from '@planted/schema';
import * as Y from 'yjs';

/**
 * Transaction origin for this client's own board edits. The undo manager tracks only this
 * origin, and `RoomClient` applies remote updates with itself as the origin, so undo can never
 * reach someone else's work.
 */
export const LOCAL_ORIGIN = Symbol('planted.local');

/** Name of the top-level `Y.Map<id, Y.Map>` holding every board object. */
export const OBJECTS = 'objects';

export type ObjectsMap = Y.Map<Y.Map<unknown>>;

export function objectsOf(doc: Y.Doc): ObjectsMap {
  return doc.getMap<Y.Map<unknown>>(OBJECTS);
}

export function newObjectId(): string {
  return base62Id(crypto.getRandomValues(new Uint8Array(OBJECT_ID_BYTES)), OBJECT_ID_LENGTH);
}

/**
 * The in-progress stroke a user streams over awareness while drawing. Points are flat
 * `[x0, y0, x1, y1, …]` in map space; `id` is the id the committed object will get.
 */
export type LiveStroke = { id: string; colour: string; width: number; points: number[] };

/** Squared distance from p to the segment a–b. */
function segmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}

/**
 * Ramer–Douglas–Peucker over flat `[x, y, …]` points. Keeps the first and last point and every
 * point further than `epsilon` from the simplified line. Iterative, so a 4,000-point stroke
 * can't overflow the stack. `epsilon <= 0` returns a copy.
 */
export function rdp(points: readonly number[], epsilon: number): number[] {
  const count = points.length >> 1;
  if (epsilon <= 0 || count <= 2) return points.slice(0, count * 2);
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const epsilonSq = epsilon * epsilon;
  const stack: number[] = [0, count - 1];
  while (stack.length > 0) {
    const last = stack.pop() as number;
    const first = stack.pop() as number;
    const ax = points[first * 2] as number;
    const ay = points[first * 2 + 1] as number;
    const bx = points[last * 2] as number;
    const by = points[last * 2 + 1] as number;
    let maxSq = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistanceSq(
        points[i * 2] as number,
        points[i * 2 + 1] as number,
        ax,
        ay,
        bx,
        by,
      );
      if (d > maxSq) {
        maxSq = d;
        index = i;
      }
    }
    if (index !== -1 && maxSq > epsilonSq) {
      keep[index] = 1;
      stack.push(first, index, index, last);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (keep[i]) out.push(points[i * 2] as number, points[i * 2 + 1] as number);
  }
  return out;
}

/** Flat points as Float32 pairs, stored as raw bytes in the doc. */
export function packPoints(points: readonly number[]): Uint8Array {
  return new Uint8Array(new Float32Array(points).buffer);
}

export function unpackPoints(bytes: Uint8Array): Float32Array {
  // Copy: the Yjs-owned bytes may sit at an offset that isn't 4-byte aligned.
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, 0, copy.byteLength >> 2);
}

export type StrokeInput = {
  id: string;
  floor: string;
  colour: string;
  width: number;
  /** Raw flat map-space points, before simplification. */
  points: readonly number[];
  /** RDP epsilon in map units: 1 screen px at the current zoom. */
  epsilon: number;
  by: string;
  at?: number;
};

/**
 * Simplify and validate a stroke. If it still has too many points (a very long scribble), the
 * epsilon doubles until it fits, so a commit never fails on length.
 */
export function buildStroke(input: StrokeInput): StrokeObject {
  let epsilon = input.epsilon;
  let points = rdp(input.points, epsilon);
  while (points.length / 2 > MAX_STROKE_POINTS) {
    epsilon = epsilon > 0 ? epsilon * 2 : 1e-6;
    points = rdp(input.points, epsilon);
  }
  return StrokeObject.parse({
    kind: 'stroke',
    floor: input.floor,
    phase: null,
    colour: input.colour,
    width: input.width,
    points: packPoints(points),
    by: input.by,
    at: input.at ?? Date.now(),
  });
}

/** One nested map per object, so later tools can change single fields. */
function toYMap(object: StrokeObject): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(object)) map.set(key, value);
  return map;
}

/** Commit a stroke as one transaction with `LOCAL_ORIGIN`: one stroke is one undo step. */
export function commitStroke(doc: Y.Doc, input: StrokeInput): StrokeObject {
  const stroke = buildStroke(input);
  doc.transact(() => objectsOf(doc).set(input.id, toYMap(stroke)), LOCAL_ORIGIN);
  return stroke;
}

/** A nested object map's fields as a plain object, ready for `safeParse`. */
export function readObject(map: Y.Map<unknown>): Record<string, unknown> {
  return Object.fromEntries(map.entries());
}

/** Per-user undo: tracks only `LOCAL_ORIGIN`, one transaction per step. */
export function createUndoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(objectsOf(doc), {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 0,
  });
}
