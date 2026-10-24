import type { FastifyBaseLogger } from 'fastify';

/** Milliseconds from `now` until the next `hour`:00 local server time (tomorrow if it's past). */
export function msUntilNextHour(now: Date, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Runs `job` every day at `hour`:00 server time. A daily timer is all the scheduling this needs;
 * no cron dependency. Each run reschedules from the clock, so drift and DST don't accumulate.
 * Errors are logged and the next day's run still happens. Returns a stop function.
 */
export function scheduleDaily(
  name: string,
  hour: number,
  job: () => Promise<unknown>,
  log: FastifyBaseLogger,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(
      async () => {
        try {
          await job();
        } catch (err) {
          log.error({ err, job: name }, 'jobs.failed');
        }
        arm();
      },
      msUntilNextHour(new Date(), hour),
    );
    // A pending daily job must not keep the process alive on shutdown.
    timer.unref();
  };
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
