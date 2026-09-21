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

/**
 * A dedicated connection pool for account advisory locks, separate from the
 * query pool. A session-level advisory lock holds its connection for the whole
 * critical section; if those came from the query pool, enough
 * concurrently-trading accounts would starve queries of connections and
 * deadlock. Keeping locks on their own pool makes the two independent.
 */
let lockPool: postgres.Sql | null = null;

export function getLockSql(url = env().DATABASE_URL): postgres.Sql {
  if (!lockPool) {
    lockPool = postgres(url, { max: 20, idle_timeout: 20, transform: { undefined: null }, onnotice: () => {} });
  }
  return lockPool;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.sql.end({ timeout: 5 });
    singleton = null;
  }
  if (lockPool) {
    await lockPool.end({ timeout: 5 });
    lockPool = null;
  }
}

export { schema };
