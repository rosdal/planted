import { createHash } from 'node:crypto';
import { RoomId, RoomRole } from '@planted/schema';
import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

/** Room tokens live 5 minutes; clients fetch a fresh one before every `hello`. */
export const ROOM_TOKEN_TTL_S = 5 * 60;

const Claims = z.object({ sub: RoomId, role: RoomRole, lid: z.string().min(1), exp: z.number() });

export type RoomTokenClaims = { roomId: RoomId; role: RoomRole; lid: string; expiresAt: Date };

/** Any reason a token can't be used: malformed, wrong signature, unknown `kid`, or expired. */
export class TokenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TokenError';
  }
}

type Key = { kid: string; bytes: Uint8Array };

function keyOf(secret: string): Key {
  // The kid names the secret without revealing it, so a rotation needs no extra config.
  const kid = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  return { kid, bytes: new TextEncoder().encode(secret) };
}

export type RoomTokensOptions = {
  secret: string;
  previous?: string | undefined;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Signs and verifies room tokens: HS256 JWTs with `sub` = room id, `role`, `lid` = the link it
 * came from (ADR 0005). Signs with the current secret; verifies with the current or previous one,
 * picked by the `kid` header.
 */
export class RoomTokens {
  readonly #current: Key;
  readonly #keys: Map<string, Key>;
  readonly #now: () => number;

  constructor({ secret, previous, now = Date.now }: RoomTokensOptions) {
    this.#current = keyOf(secret);
    this.#keys = new Map([[this.#current.kid, this.#current]]);
    if (previous) {
      const old = keyOf(previous);
      this.#keys.set(old.kid, old);
    }
    this.#now = now;
  }

  async sign(claims: {
    roomId: RoomId;
    role: RoomRole;
    lid: string;
  }): Promise<{ token: string; expiresAt: Date }> {
    const iat = Math.floor(this.#now() / 1000);
    const exp = iat + ROOM_TOKEN_TTL_S;
    const token = await new SignJWT({ role: claims.role, lid: claims.lid })
      .setProtectedHeader({ alg: 'HS256', kid: this.#current.kid })
      .setSubject(claims.roomId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.#current.bytes);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** Throws `TokenError` for anything but a valid, unexpired token signed by a known secret. */
  async verify(token: string): Promise<RoomTokenClaims> {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch (err) {
      throw new TokenError('malformed token', { cause: err });
    }
    const key = kid === undefined ? undefined : this.#keys.get(kid);
    if (!key) throw new TokenError('unknown signing key');
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, key.bytes, {
        algorithms: ['HS256'],
        currentDate: new Date(this.#now()),
      }));
    } catch (err) {
      throw new TokenError('invalid or expired token', { cause: err });
    }
    const parsed = Claims.safeParse(payload);
    if (!parsed.success) throw new TokenError('token claims are malformed');
    const { sub, role, lid, exp } = parsed.data;
    return { roomId: sub, role, lid, expiresAt: new Date(exp * 1000) };
  }
}
