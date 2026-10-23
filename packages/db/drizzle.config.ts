import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// Locally the root .env holds DATABASE_URL; in CI it comes from the job environment.
const envFile = new URL('../../.env', import.meta.url);
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set; copy .env.example to .env');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url },
  strict: true,
});
