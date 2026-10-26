import { z } from 'zod';

/**
 * At least 32 random bytes, as the base64url string `crypto.randomBytes(32).toString('base64url')`
 * prints (43 characters). Randomness can't be checked, but a short or placeholder secret can.
 */
const TokenSecret = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43,}$/, 'must be at least 32 random bytes as base64url (43+ characters)');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  SERVER_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SERVER_HOST: z.string().min(1).default('0.0.0.0'),
  WEB_ORIGIN: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /**
   * Behind a reverse proxy (Caddy in production), take the client address from
   * `X-Forwarded-For`; otherwise every user shares the proxy's rate-limit bucket.
   */
  TRUST_PROXY: z.stringbool().default(false),
  /** `POST /rooms` per client address per minute. Raised only for the e2e suite. */
  ROOMS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Signs room tokens (ADR 0005). */
  ROOM_TOKEN_SECRET: TokenSecret,
  /** The secret before the last rotation; tokens it signed stay valid until they expire. */
  ROOM_TOKEN_SECRET_PREVIOUS: TokenSecret.optional(),
});
export type Env = z.infer<typeof Env>;

export function parseEnv(source: NodeJS.ProcessEnv) {
  return Env.safeParse(source);
}

/** Parse `process.env` once at startup; on failure name every bad key and exit 1. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = parseEnv(source);
  if (result.success) return result.data;
  console.error('Invalid environment (see .env.example):');
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}
