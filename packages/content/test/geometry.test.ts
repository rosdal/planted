import { describe, expect, it } from 'vitest';
import {
  apply,
  flattenPath,
  parseTransform,
  selfIntersection,
  simplify,
} from '../scripts/lib/geometry';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe('parseTransform', () => {
  it('applies a list left to right, as SVG nests them', () => {
    // translate then scale: the point is scaled first, then moved.
    const m = parseTransform('translate(10 20) scale(2)');
    expect(apply(m, [1, 1])).toEqual([12, 22]);
  });

  it('rotates about a centre', () => {
    const [x, y] = apply(parseTransform('rotate(90 10 10)'), [20, 10]);
    expect(close(x, 10) && close(y, 20)).toBe(true);
  });

  it('refuses a transform it does not know', () => {
    expect(() => parseTransform('perspective(3)')).toThrow(/unknown transform/);
  });
});

describe('flattenPath', () => {
  it('reports a path ending in Z as closed', () => {
    expect(flattenPath('M0 0H10V10Z')).toEqual([
      {
        points: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        closed: true,
      },
    ]);
  });

  it('samples a curve at about one unit', () => {
    const [sub] = flattenPath('M0 0C0 50 100 50 100 0');
    expect(sub?.points.length).toBeGreaterThan(150);
    expect(sub?.points.at(-1)).toEqual([100, 0]);
  });

  it('reflects the previous control point for S', () => {
    // S after C mirrors (100, 50) about (100, 0) to (100, -50): the curve dips below 0.
    const [sub] = flattenPath('M0 0C0 50 100 50 100 0S200 -50 200 0');
    const lowest = Math.min(...(sub?.points ?? []).map((p) => p[1]));
    expect(lowest).toBeLessThan(-30);
  });
});

describe('simplify', () => {
  it('drops points on a straight run and keeps corners', () => {
    const run: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 1],
      [3, 2],
    ];
    expect(simplify(run, 0.1)).toEqual([
      [0, 0],
      [3, 0],
      [3, 2],
    ]);
  });
});

describe('selfIntersection', () => {
  it('is null for a square and finds the crossing in a bow tie', () => {
    expect(
      selfIntersection([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    ).toBeNull();
    expect(
      selfIntersection([
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ]),
    ).toEqual([0, 2]);
  });
});
