import { createDb } from '@planted/db';
import { migrateDb } from '@planted/db/testing';
import { testDatabaseUrl } from './helpers';

/** Runs once per `vitest run`: bring `planted_test` up to the committed migrations. */
export default async function setup(): Promise<void> {
  const { db, close } = createDb(testDatabaseUrl());
  try {
    await migrateDb(db);
  } finally {
    await close();
  }
}
