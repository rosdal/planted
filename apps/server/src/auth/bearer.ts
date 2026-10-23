import type { Db } from '@planted/db';
import type { RoomId, RoomRole } from '@planted/schema';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { isLinkActive } from './links';
import { type RoomTokenClaims, type RoomTokens, TokenError } from './room-token';

/**
 * The verified claims of the request's `Authorization: Bearer` room token, for `roomId`.
 * 401 when the token is missing, bad, expired or from a revoked link; 403 when it's for
 * another room, or `role` is given and the token's role isn't it.
 */
export async function requireRoomToken(
  request: FastifyRequest,
  { db, tokens }: { db: Db; tokens: RoomTokens },
  roomId: RoomId,
  role?: RoomRole,
): Promise<RoomTokenClaims> {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer (\S+)$/);
  if (!match?.[1]) throw new AppError('unauthorized', 401, 'Room token required');
  let claims: RoomTokenClaims;
  try {
    claims = await tokens.verify(match[1]);
  } catch (err) {
    if (err instanceof TokenError) throw new AppError('unauthorized', 401, 'Invalid room token');
    throw err;
  }
  if (claims.roomId !== roomId) throw new AppError('forbidden', 403, 'Token is for another room');
  if (!(await isLinkActive(db, roomId, claims.lid))) {
    throw new AppError('unauthorized', 401, 'This link was revoked');
  }
  if (role && claims.role !== role) {
    throw new AppError('forbidden', 403, `Needs the ${role} role`);
  }
  return claims;
}
