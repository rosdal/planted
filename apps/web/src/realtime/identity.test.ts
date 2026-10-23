import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGuestIdentity, USER_COLOURS } from './identity';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadGuestIdentity', () => {
  it('creates a name and palette colour, and keeps it for next time', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const first = loadGuestIdentity();
    expect(first.name).toMatch(/^Guest \d{4}$/);
    expect(USER_COLOURS).toContain(first.colour);
    expect(loadGuestIdentity()).toEqual(first);
  });

  it('replaces a corrupt stored value', () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'planted.guest': '{not json' }));
    expect(loadGuestIdentity().name).toMatch(/^Guest/);
  });

  it('still returns an identity when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(loadGuestIdentity().name).toMatch(/^Guest/);
  });
});
