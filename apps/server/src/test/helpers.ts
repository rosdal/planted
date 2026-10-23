import { createDb, type Db } from '@planted/db';
import { resetDb } from '@planted/db/testing';
import { type App, buildApp } from '../app';

export const testEnv = {
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'silent',
} as const;

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set; copy .env.example to .env');
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL must point at a *_test database, got ${url}`);
  }
  return url;
}

export type TestApp = { app: App; db: Db; close: () => Promise<void> };

/** A fresh app on an emptied `planted_test`. Call `close` in `afterEach`. */
export async function makeTestApp(): Promise<TestApp> {
  const { db, close: closeDb } = createDb(testDatabaseUrl());
  await resetDb(db);
  const app = await buildApp({ db, env: testEnv });
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await closeDb();
    },
  };
}
