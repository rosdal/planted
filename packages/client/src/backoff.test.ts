import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff';

describe('backoffDelay', () => {
  it('doubles from 250 ms with no jitter at random() = 0.5', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffDelay(n, () => 0.5))).toEqual([
      250, 500, 1000, 2000, 4000, 8000,
    ]);
  });

  it('caps at 10 s before jitter', () => {
    expect(backoffDelay(6, () => 0.5)).toBe(10_000);
    expect(backoffDelay(50, () => 0.5)).toBe(10_000);
  });

  it('jitters by ±50%', () => {
    expect(backoffDelay(2, () => 0)).toBe(500);
    expect(backoffDelay(2, () => 0.999_999)).toBe(1500);
    expect(backoffDelay(50, () => 0)).toBe(5000);
  });
});
