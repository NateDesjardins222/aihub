/** Applies generated SQL migrations. Safe to run repeatedly. */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDb } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const { sql, db } = createDb();
  try {
    await migrate(db, { migrationsFolder: resolve(here, '../../drizzle') });
    console.log('migrations applied');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
