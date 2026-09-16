/** Database client. One pool per process; transactions come from drizzle. */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

export interface DbHandle {
  readonly sql: postgres.Sql;
  readonly db: Database;
}

export function createDb(url = env().DATABASE_URL): DbHandle {
  const sql = postgres(url, {
    max: 10,
    idle_timeout: 20,
    transform: { undefined: null },
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema }) };
}

let singleton: DbHandle | null = null;

export function getDb(): DbHandle {
  if (!singleton) singleton = createDb();
  return singleton;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.sql.end({ timeout: 5 });
    singleton = null;
  }
}

export { schema };
