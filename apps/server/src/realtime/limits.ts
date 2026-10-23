import { MAX_FRAME_BYTES } from '@planted/protocol';
import type { RoomLimits } from '@planted/schema';

/** Most objects one board may hold; an update past it has its new objects removed. */
export const MAX_OBJECTS = 20_000;
/** Encoded doc size, checked at every save; past it the room stops accepting new objects. */
export const MAX_DOC_BYTES = 5 * 1024 * 1024;
/** The 51st socket in a room is closed with 4429. */
export const MAX_SOCKETS_PER_ROOM = 50;

export const FRAMES_PER_SEC = 200;
export const FRAME_BURST = 400;
export const BYTES_PER_SEC = 512 * 1024;
/** Yjs frames stay over the limit this long before the socket is closed with 4429. */
export const OVER_LIMIT_CLOSE_MS = 2000;
/**
 * An overrun ends after this long with no Yjs frame over the limit. Not on the first frame
 * under it: during a flood the buckets refill continuously and let a few frames through.
 */
export const OVER_LIMIT_QUIET_MS = 1000;

/** What `welcome.limits` tells the client. */
export const ROOM_LIMITS: RoomLimits = { maxFrameBytes: MAX_FRAME_BYTES, maxObjects: MAX_OBJECTS };

/** Classic token bucket: `capacity` tokens, refilled at `perSec`. `take` never goes negative. */
export class TokenBucket {
  #tokens: number;
  #at: number;

  constructor(
    readonly perSec: number,
    readonly capacity: number,
    private readonly now: () => number,
  ) {
    this.#tokens = capacity;
    this.#at = now();
  }

  take(n: number): boolean {
    const now = this.now();
    this.#tokens = Math.min(this.capacity, this.#tokens + ((now - this.#at) / 1000) * this.perSec);
    this.#at = now;
    if (this.#tokens < n) return false;
    this.#tokens -= n;
    return true;
  }
}

export type FrameKind = 'yjs' | 'sync2' | 'awareness' | 'other';
/** `drop` the frame (awareness only), or `close` the socket with 4429. */
export type Verdict = 'ok' | 'drop' | 'close';

/**
 * Per-socket inbound limits: 200 frames/s (burst 400) and 512 KB/s. Over the limit, awareness
 * frames are dropped first; Yjs frames are still applied (dropping one would lose an edit) until
 * they have been over for 2 s, and then the socket is closed. The first sync-2 counts as a frame
 * but not against the byte budget: it carries a whole doc of up to 5 MB once per connection.
 * Every later one counts in full, so a client can't send its updates as sync-2 to dodge it.
 */
export class SocketLimiter {
  readonly #frames: TokenBucket;
  readonly #bytes: TokenBucket;
  readonly #now: () => number;
  #yjsOverSince: number | null = null;
  #yjsOverAt = Number.NEGATIVE_INFINITY;
  #sawSync2 = false;

  constructor(now: () => number = performance.now.bind(performance)) {
    this.#now = now;
    this.#frames = new TokenBucket(FRAMES_PER_SEC, FRAME_BURST, now);
    this.#bytes = new TokenBucket(BYTES_PER_SEC, BYTES_PER_SEC, now);
  }

  check(kind: FrameKind, bytes: number): Verdict {
    const frameOk = this.#frames.take(1);
    const exempt = kind === 'sync2' && !this.#sawSync2;
    if (kind === 'sync2') this.#sawSync2 = true;
    const bytesOk = exempt || this.#bytes.take(bytes);
    const within = frameOk && bytesOk;
    if (kind === 'yjs' || kind === 'sync2') {
      const now = this.#now();
      if (now - this.#yjsOverAt > OVER_LIMIT_QUIET_MS) this.#yjsOverSince = null;
      if (within) return 'ok';
      this.#yjsOverAt = now;
      this.#yjsOverSince ??= now;
      return now - this.#yjsOverSince >= OVER_LIMIT_CLOSE_MS ? 'close' : 'ok';
    }
    return within ? 'ok' : 'drop';
  }
}
