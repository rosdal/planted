import { describe, expect, it } from 'vitest';
import { cachedTokens, type IssuedToken } from './tokens';

/** Issues t1, t2, … each valid for 5 minutes from the fake clock, and counts the requests. */
function issuer(clock: { now: number }) {
  let n = 0;
  const issue = async (): Promise<IssuedToken> => {
    n++;
    return { token: `t${n}`, expiresAt: new Date(clock.now + 5 * 60_000).toISOString() };
  };
  return { issue, count: () => n };
}

describe('cachedTokens', () => {
  it('reuses a token until a minute before it expires', async () => {
    const clock = { now: 0 };
    const { issue, count } = issuer(clock);
    const getToken = cachedTokens(issue, { now: () => clock.now });
    expect(await getToken()).toBe('t1');
    clock.now = 3 * 60_000;
    expect(await getToken()).toBe('t1');
    clock.now = 4 * 60_000 + 1;
    expect(await getToken()).toBe('t2');
    expect(count()).toBe(2);
  });

  it('always fetches a new one for a refresh after a 4401', async () => {
    const clock = { now: 0 };
    const { issue } = issuer(clock);
    const getToken = cachedTokens(issue, { now: () => clock.now });
    expect(await getToken('connect')).toBe('t1');
    expect(await getToken('refresh')).toBe('t2');
  });

  it('starts from a token already in hand', async () => {
    const clock = { now: 0 };
    const { issue, count } = issuer(clock);
    const initial = { token: 'loader', expiresAt: new Date(5 * 60_000).toISOString() };
    const getToken = cachedTokens(issue, { now: () => clock.now, initial });
    expect(await getToken()).toBe('loader');
    expect(count()).toBe(0);
  });

  it('shares one request between concurrent callers', async () => {
    const clock = { now: 0 };
    const { issue, count } = issuer(clock);
    const getToken = cachedTokens(issue, { now: () => clock.now });
    expect(await Promise.all([getToken(), getToken(), getToken()])).toEqual(['t1', 't1', 't1']);
    expect(count()).toBe(1);
  });

  it('forgets a rejected token even when the refresh itself fails', async () => {
    const clock = { now: 0 };
    let fail = false;
    let n = 0;
    const getToken = cachedTokens(
      async () => {
        n++;
        if (fail) throw new Error('429');
        return { token: `t${n}`, expiresAt: new Date(5 * 60_000).toISOString() };
      },
      { now: () => clock.now },
    );
    expect(await getToken()).toBe('t1');
    fail = true;
    await expect(getToken('refresh')).rejects.toThrow('429');
    fail = false;
    expect(await getToken('connect')).toBe('t3');
  });
});
