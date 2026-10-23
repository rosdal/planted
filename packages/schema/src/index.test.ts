import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './index';

describe('PROTOCOL_VERSION', () => {
  it('is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
