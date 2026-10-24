import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyFromHash, readKey, readViewKey, saveKeys, shareUrl, takeKeyFromHash } from './keys';

function memoryStorage() {
  const data = new Map<string, string>();
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

const key = 'K'.repeat(43);

describe('keyFromHash', () => {
  it.each([
    ['#k=abc', 'abc'],
    ['k=abc', 'abc'],
    ['#x=1&k=abc', 'abc'],
    ['#', null],
    ['', null],
    [`#k=${'a'.repeat(129)}`, null],
  ])('%j → %j', (hash, expected) => {
    expect(keyFromHash(hash)).toBe(expected);
  });
});

describe('room keys in storage', () => {
  it('stores a share link key under room:<id>:key, replacing an older one', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    takeKeyFromHash('room1', '#k=old');
    takeKeyFromHash('room1', `#k=${key}`);
    expect(storage.data.get('room:room1:key')).toBe(key);
    expect(readKey('room1')).toBe(key);
  });

  it('leaves the stored key alone when the URL has none', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    saveKeys('room2', { editKey: key, viewKey: 'view' });
    takeKeyFromHash('room2', '');
    expect(readKey('room2')).toBe(key);
    expect(readViewKey('room2')).toBe('view');
  });

  it('keeps the edit key when the creator opens their own view link', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    saveKeys('room5', { editKey: key, viewKey: 'view' });
    takeKeyFromHash('room5', '#k=view');
    expect(readKey('room5')).toBe(key);
  });

  it('keeps working for this tab when storage throws', () => {
    vi.stubGlobal('localStorage', throwingStorage);
    takeKeyFromHash('room3', `#k=${key}`);
    expect(readKey('room3')).toBe(key);
    expect(readKey('room4')).toBeNull();
  });
});

describe('shareUrl', () => {
  it('puts the key in the fragment, never the path or query', () => {
    expect(shareUrl('https://planted.gg', 'abc', key)).toBe(`https://planted.gg/r/abc#k=${key}`);
  });
});
