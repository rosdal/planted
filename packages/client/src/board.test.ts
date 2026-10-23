import { MAX_STROKE_POINTS, StrokeObject } from '@planted/schema';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  buildStroke,
  commitStroke,
  createUndoManager,
  newObjectId,
  objectsOf,
  packPoints,
  rdp,
  type StrokeInput,
  unpackPoints,
} from './board';
import { docHash } from './doc-hash';

describe('rdp', () => {
  it('turns a straight 1,000-point line into its 2 ends', () => {
    const line = Array.from({ length: 1000 }, (_, i) => [i / 999, (i / 999) * 0.5]).flat();
    expect(rdp(line, 1e-4)).toEqual([0, 0, 1, 0.5]);
  });

  it('keeps the 4 corners of a square drawn with many points', () => {
    const square: number[] = [];
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ] as const;
    for (let c = 0; c < 4; c++) {
      const [ax, ay] = corners[c] as readonly [number, number];
      const [bx, by] = corners[c + 1] as readonly [number, number];
      for (let i = 0; i < 50; i++)
        square.push(ax + ((bx - ax) * i) / 50, ay + ((by - ay) * i) / 50);
    }
    square.push(0, 0);
    expect(rdp(square, 0.01)).toEqual([0, 0, 1, 0, 1, 1, 0, 1, 0, 0]);
  });

  it('keeps everything at epsilon 0, collinear points included', () => {
    const line = [0, 0, 0.5, 0.5, 1, 1];
    expect(rdp(line, 0)).toEqual(line);
  });

  it('leaves a single point alone', () => {
    expect(rdp([0.3, 0.4], 0.1)).toEqual([0.3, 0.4]);
  });
});

describe('point packing', () => {
  it('round-trips float32 values exactly', () => {
    const points = Array.from({ length: 200 }, () => Math.fround(Math.random()));
    expect([...unpackPoints(packPoints(points))]).toEqual(points);
  });

  it('reads bytes that sit at an unaligned offset', () => {
    const packed = packPoints([0.25, 0.75]);
    const shifted = new Uint8Array(packed.byteLength + 1);
    shifted.set(packed, 1);
    expect([...unpackPoints(shifted.subarray(1))]).toEqual([0.25, 0.75]);
  });

  it('has the schema reject more than the point limit', () => {
    const tooMany = packPoints(new Array((MAX_STROKE_POINTS + 1) * 2).fill(0.5));
    const stroke = { ...stroke1(), points: tooMany };
    expect(StrokeObject.safeParse(stroke).success).toBe(false);
  });
});

function input(overrides: Partial<StrokeInput> = {}): StrokeInput {
  return {
    id: newObjectId(),
    floor: 'test-1',
    colour: '#57ab5a',
    width: 0.002,
    points: [0.1, 0.1, 0.2, 0.3, 0.4, 0.2],
    epsilon: 0,
    by: 'Ash',
    ...overrides,
  };
}

function stroke1() {
  return buildStroke(input());
}

describe('buildStroke', () => {
  it('simplifies a too-long scribble until it fits the limit', () => {
    const points = Array.from({ length: 10_000 }, (_, i) => [
      Math.random(),
      (i % 2) * 0.5 + Math.random() * 0.01,
    ]).flat();
    const stroke = buildStroke(input({ points, epsilon: 0 }));
    expect(stroke.points.byteLength / 8).toBeLessThanOrEqual(MAX_STROKE_POINTS);
  });
});

/** Two docs wired together directly, both ways, as two clients through the relay. */
function syncedPair(): [Y.Doc, Y.Doc] {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== b) Y.applyUpdate(b, update, a);
  });
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== a) Y.applyUpdate(a, update, b);
  });
  return [a, b];
}

describe('undo isolation', () => {
  it("undoing in A removes only A's stroke, on both docs", () => {
    const [a, b] = syncedPair();
    const undoA = createUndoManager(a);
    const undoB = createUndoManager(b);
    const strokeA = input();
    const strokeB = input({ by: 'Mute' });
    commitStroke(a, strokeA);
    commitStroke(b, strokeB);
    expect(objectsOf(a).size).toBe(2);
    expect(objectsOf(b).size).toBe(2);

    undoA.undo();
    for (const doc of [a, b]) {
      expect([...objectsOf(doc).keys()]).toEqual([strokeB.id]);
    }
    expect(docHash(a)).toBe(docHash(b));

    // Nothing more for A to undo: B's stroke was never on A's stack.
    expect(undoA.canUndo()).toBe(false);
    undoA.undo();
    expect(objectsOf(a).size).toBe(1);

    undoA.redo();
    expect(objectsOf(b).has(strokeA.id)).toBe(true);
    expect(undoB.undoStack).toHaveLength(1);
  });

  it('makes each stroke its own undo step', () => {
    const doc = new Y.Doc();
    const undo = createUndoManager(doc);
    commitStroke(doc, input());
    commitStroke(doc, input());
    undo.undo();
    expect(objectsOf(doc).size).toBe(1);
  });
});
