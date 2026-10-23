/**
 * Every WebSocket close code either side uses. 4xxx mirror the HTTP status they're named after,
 * so a log line reads without a lookup table. How the client reacts to each is in
 * packages/client/src/room-client.ts.
 */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  Internal: 1011,
  /** A frame or update that doesn't decode or validate, or a Yjs frame before `welcome`. */
  BadFrame: 4400,
  /** Missing, bad, expired or revoked token; also no `hello` within 5 s, and link rotation. */
  BadToken: 4401,
  /** The token's role doesn't allow what the socket tried, e.g. a viewer sending an update. */
  Forbidden: 4403,
  RoomNotFound: 4404,
  /** The room's doc was replaced; the client drops its doc and resyncs. */
  EpochChanged: 4409,
  DocLimit: 4413,
  /** `hello.protocol` is older than the server speaks. */
  ProtocolTooOld: 4426,
  /** Frame rate, bytes or sockets per room over the limit. */
  RateLimited: 4429,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
