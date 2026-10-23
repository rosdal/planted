import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  firstFreeColour,
  isValidName,
  loadGuestIdentity,
  readStoredIdentity,
  saveGuestIdentity,
  USER_COLOURS,
} from './identity';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('guest identity', () => {
  it('is a first visit until the dialog saves, with one fallback per tab meanwhile', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(readStoredIdentity()).toBeNull();
    const first = loadGuestIdentity();
    expect(first.name).toMatch(/^Guest \d{4}$/);
    expect(USER_COLOURS).toContain(first.colour);
    expect(loadGuestIdentity()).toEqual(first);
  });

  it('keeps a saved identity for next time', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(saveGuestIdentity({ name: 'Ash', colour: '#57ab5a' })).toBe(true);
    expect(readStoredIdentity()).toEqual({ name: 'Ash', colour: '#57ab5a' });
    expect(loadGuestIdentity().name).toBe('Ash');
  });

  it('treats a corrupt stored value as a first visit', () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'planted.guest': '{not json' }));
    expect(readStoredIdentity()).toBeNull();
  });

  it('still works when storage throws', () => {
    vi.stubGlobal('localStorage', throwingStorage);
    expect(readStoredIdentity()).toBeNull();
    expect(saveGuestIdentity({ name: 'Mute', colour: '#e5534b' })).toBe(false);
    expect(loadGuestIdentity().name).toBe('Mute');
  });
});

describe('isValidName', () => {
  it.each([
    ['a', false],
    ['Ab', true],
    ['   Ab   ', true],
    ['x'.repeat(20), true],
    ['x'.repeat(21), false],
    ['   ', false],
  ])('%j → %s', (name, valid) => {
    expect(isValidName(name)).toBe(valid);
  });
});

describe('firstFreeColour', () => {
  it('keeps your colour when nobody has it', () => {
    expect(firstFreeColour('#b083f0', new Set(['#e5534b']))).toBe('#b083f0');
  });

  it('picks the first free one when yours is taken', () => {
    const taken = new Set([USER_COLOURS[0], USER_COLOURS[1], '#b083f0']);
    expect(firstFreeColour('#b083f0', taken)).toBe(USER_COLOURS[2]);
  });

  it('keeps your colour when every colour is taken', () => {
    expect(firstFreeColour('#b083f0', new Set(USER_COLOURS))).toBe('#b083f0');
  });
});
