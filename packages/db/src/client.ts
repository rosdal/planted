import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';

/** `$client` is the raw postgres.js pool, for what drizzle can't do, like a reserved connection. */
export type Db = PostgresJsDatabase<typeof schema> & { $client: Sql };

/** No global singleton: the server makes one per process, tests make their own. */
export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, { max: 10, connect_timeout: 5, onnotice: () => {} });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}
