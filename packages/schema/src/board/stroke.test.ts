import { describe, expect, it } from 'vitest';
import { MAX_STROKE_POINTS, StrokeObject } from './stroke';

const valid = {
  kind: 'stroke',
  floor: 'test-1',
  phase: null,
  colour: '#57ab5a',
  width: 0.002,
  points: new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer),
  by: 'Ash',
  at: 1,
} as const;

describe('StrokeObject', () => {
  it('accepts a valid stroke', () => {
    expect(StrokeObject.safeParse(valid).success).toBe(true);
  });

  it('accepts exactly the point limit and rejects one more', () => {
    const at = (n: number) => ({ ...valid, points: new Uint8Array(n * 8) });
    expect(StrokeObject.safeParse(at(MAX_STROKE_POINTS)).success).toBe(true);
    expect(StrokeObject.safeParse(at(MAX_STROKE_POINTS + 1)).success).toBe(false);
  });

  it.each([
    ['half a point', { points: new Uint8Array(4) }],
    ['no points', { points: new Uint8Array(0) }],
    ['a number array', { points: [0.1, 0.2] }],
    ['a named colour', { colour: 'red' }],
    ['a too-thin width', { width: 0.0001 }],
    ['a too-wide width', { width: 0.03 }],
    ['another kind', { kind: 'arrow' }],
  ])('rejects %s', (_, patch) => {
    expect(StrokeObject.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
