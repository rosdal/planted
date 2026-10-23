export const BACKOFF_BASE_MS = 250;
export const BACKOFF_MAX_MS = 10_000;
/** A connection that stays open this long resets the attempt counter. */
export const STABLE_AFTER_MS = 10_000;

/** 250 ms × 2^attempt, capped at 10 s, then ±50% jitter so a restarted server isn't stampeded. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.5 + random()));
}
