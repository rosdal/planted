import { z } from 'zod';

/**
 * Payloads of the control (0) and app (3) channels, CBOR on the wire. Every object is strict:
 * an unknown field is a malformed frame, not something to ignore, so a newer client can't
 * smuggle fields into an older server unnoticed. Adding a field means bumping `protocol`.
 */

export const RoomRole = z.enum(['edit', 'view']);
export type RoomRole = z.infer<typeof RoomRole>;

const Timestamp = z.number().finite();

// Control channel

export const HelloMessage = z.strictObject({
  /** Wire protocol version; the server answers anything it doesn't speak with 4426. */
  protocol: z.number().int().nonnegative(),
  /** A room token from `POST /rooms/:roomId/token`. */
  token: z.string().min(1).max(4096),
  /** Shown in server logs; the name peers see travels over awareness. */
  clientName: z.string().min(1).max(64),
  /** Reserved: the client's state vector, so a later server can answer with the diff at once. */
  stateVector: z.instanceof(Uint8Array).optional(),
});
export type HelloMessage = z.infer<typeof HelloMessage>;

export const RoomLimits = z.strictObject({
  maxFrameBytes: z.number().int().positive(),
  maxObjects: z.number().int().positive(),
});
export type RoomLimits = z.infer<typeof RoomLimits>;

export const WelcomeMessage = z.strictObject({
  role: RoomRole,
  /** Bumps when the doc is replaced; a client on another epoch throws its doc away. */
  roomEpoch: z.number().int().positive(),
  serverTime: Timestamp,
  limits: RoomLimits,
});
export type WelcomeMessage = z.infer<typeof WelcomeMessage>;

export const ErrorMessage = z.strictObject({
  /** A plain string, so an older client still parses codes added later. */
  code: z.string().min(1).max(64),
  message: z.string().max(1024),
  /** True when a close follows; false for warnings like `object_limit`. */
  fatal: z.boolean(),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const PingMessage = z.strictObject({ t: Timestamp });
export type PingMessage = z.infer<typeof PingMessage>;

export const PongMessage = z.strictObject({ t: Timestamp });
export type PongMessage = z.infer<typeof PongMessage>;

// App channel: types defined in 0.4, handlers arrive in 0.6 (ping-map) and 0.7 (kick).

export const PingMapMessage = z.strictObject({
  /** Map space, 0..1 per floor. */
  at: z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
  floor: z.string().min(1).max(64),
  kind: z.string().min(1).max(32),
});
export type PingMapMessage = z.infer<typeof PingMapMessage>;

export const KickMessage = z.strictObject({ userId: z.string().min(1).max(64) });
export type KickMessage = z.infer<typeof KickMessage>;
