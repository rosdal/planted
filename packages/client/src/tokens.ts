import { RoomTokenResponse } from '@planted/schema';
import { LinkRevokedError, type TokenReason } from './room-client';

export type IssuedToken = { token: string; expiresAt: string };

/**
 * `POST /rooms/:roomId/token` with a link key. A 403 (wrong, revoked or rotated key) throws
 * `LinkRevokedError`; anything else that isn't a token throws a plain `Error`.
 */
export async function fetchRoomToken(
  apiUrl: string,
  roomId: string,
  key: string,
): Promise<IssuedToken> {
  const res = await fetch(
    `${apiUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomId)}/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    },
  );
  if (res.status === 403) throw new LinkRevokedError();
  if (!res.ok) throw new Error(`POST /rooms/${roomId}/token answered ${res.status}`);
  return RoomTokenResponse.parse(await res.json());
}

/**
 * A `getToken` for `RoomClient` that reuses a token until a minute before it expires, and always
 * fetches a new one for `refresh` (after a 4401). Share one between clients of the same room to
 * stay under the token route's 30 requests a minute: 20 bots reconnecting would otherwise trip it.
 * Concurrent callers share one request.
 */
export function cachedTokens(
  issue: () => Promise<IssuedToken>,
  {
    marginMs = 60_000,
    now = Date.now,
    initial,
  }: {
    marginMs?: number;
    now?: () => number;
    /** A token already in hand, e.g. the one the page loader fetched moments ago. */
    initial?: IssuedToken | undefined;
  } = {},
): (reason?: TokenReason) => Promise<string> {
  let current: { token: string; expiresAt: number } | null = initial
    ? { token: initial.token, expiresAt: Date.parse(initial.expiresAt) }
    : null;
  let inFlight: Promise<string> | null = null;
  return (reason = 'connect') => {
    if (reason === 'connect' && current && current.expiresAt - marginMs > now()) {
      return Promise.resolve(current.token);
    }
    inFlight ??= issue()
      .then(({ token, expiresAt }) => {
        current = { token, expiresAt: Date.parse(expiresAt) };
        return token;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
