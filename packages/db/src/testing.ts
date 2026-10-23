import { fileURLToPath } from 'node:url';
import { getTableName, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client';
import * as schema from './schema';

const tableNames = Object.values(schema).map((table) => `"${getTableName(table)}"`);

/** Applies the committed migrations, so a test database never needs a manual `db:migrate`. */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
}

/** Empties every table. Only for integration tests against `planted_test`. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${tableNames.join(', ')} RESTART IDENTITY CASCADE`));
}
