import { existsSync } from 'node:fs';
import { defineProject } from 'vitest/config';

// Locally TEST_DATABASE_URL comes from the root .env; in CI from the job environment.
const envFile = new URL('../../.env', import.meta.url);
if (!process.env.TEST_DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    globalSetup: ['./src/test/global-setup.ts'],
    // Every file truncates the same database, so files must not run in parallel.
    poolOptions: { forks: { singleFork: true } },
  },
});
