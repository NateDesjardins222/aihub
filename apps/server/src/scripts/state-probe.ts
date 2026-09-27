/**
 * Cross-system state probe CLI (DEVELOPMENT / TEST ONLY).
 *
 * Read-only. Prints the authoritative snapshot for one account, resolved by
 * account UUID, public id (SIM-000123), or the owning user's email. Refuses to
 * run in production.
 *
 *   pnpm --filter @atlas/server tsx src/scripts/state-probe.ts <accountId|SIM-000123|email>
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { accounts, users } from '../db/schema.js';
import { isProduction } from '../config/env.js';
import { probeAccountState } from '../platform/state-probe.js';

async function main(): Promise<void> {
  if (isProduction()) {
    console.error('state-probe refuses to run in production.');
    process.exit(1);
  }
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: state-probe <accountId | SIM-000123 | user-email>');
    process.exit(1);
  }
  const { db, sql } = createDb();
  try {
    let accountId = arg;
    if (arg.includes('@')) {
      const [u] = await db.select().from(users).where(eq(users.email, arg));
      if (!u) { console.error(`no user with email ${arg}`); process.exit(2); }
      const [a] = await db.select().from(accounts).where(eq(accounts.userId, u.id));
      if (!a) { console.error(`user ${arg} has no accounts`); process.exit(2); }
      accountId = a.id;
    } else if (/^SIM-/i.test(arg)) {
      const [a] = await db.select().from(accounts).where(eq(accounts.publicId, arg.toUpperCase()));
      if (!a) { console.error(`no account with public id ${arg}`); process.exit(2); }
      accountId = a.id;
    }
    const snap = await probeAccountState(db, accountId);
    console.log(JSON.stringify(snap, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main();
