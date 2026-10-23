import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  SERVER_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SERVER_HOST: z.string().min(1).default('0.0.0.0'),
  WEB_ORIGIN: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
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
