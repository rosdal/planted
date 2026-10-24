import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { API_PORT, API_URL, WEB_PORT, WEB_URL } from './e2e/env';

/**
 * Browser tests against the dev server and the real relay. Ports are off the usual 3000/5173
 * so a test run doesn't collide with `pnpm dev`; locally an already-running pair is reused.
 * Needs Postgres with migrations applied (`pnpm db:up && pnpm db:migrate`), as in CI.
 */
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  // Each test runs two or three WebGL pages; in parallel they starve each other of CPU on the
  // dev server's unbundled modules, and a slow page load isn't what these tests are about.
  workers: 1,
  expect: { timeout: 15_000 },
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['github'], ['list']] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @planted/server exec tsx src/main.ts',
      url: `${API_URL}/health`,
      reuseExistingServer: !ci,
      env: {
        SERVER_PORT: String(API_PORT),
        WEB_ORIGIN: WEB_URL,
        LOG_LEVEL: 'warn',
        // A fresh secret per run unless one is set: tokens only have to verify on this server.
        ROOM_TOKEN_SECRET: process.env.ROOM_TOKEN_SECRET ?? randomBytes(32).toString('base64url'),
        DATABASE_URL:
          process.env.DATABASE_URL ?? 'postgres://planted:planted@localhost:5433/planted',
      },
    },
    {
      command: `pnpm --filter @planted/web exec vite --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      reuseExistingServer: !ci,
      env: { VITE_API_URL: API_URL },
    },
  ],
});
