/**
 * Legitimate large-firm fixtures, for measuring the operator console at scale.
 *
 * These are REAL rows: real users in the default organisation, real accounts
 * pinned to a real published product version, with the same columns provisioning
 * writes. They are inserted in bulk rather than one HTTP call each - that is the
 * only shortcut, and it changes nothing an operator's queries can observe. The
 * point of this script is to make "fast at 10k" a measured claim, not a hope.
 *
 * Dev-only. It refuses to run against NODE_ENV=production, and every user it
 * creates carries the `loadtest+` email prefix so `--clean` can remove exactly
 * what it made and nothing else.
 *
 *   pnpm --filter @atlas/server exec tsx scripts/loadtest-fixtures.ts --count 1000
 *   pnpm --filter @atlas/server exec tsx scripts/loadtest-fixtures.ts --count 10000
 *   pnpm --filter @atlas/server exec tsx scripts/loadtest-fixtures.ts --clean
 */
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { accountProfileVersions, accountProfiles, accounts, users } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/password.js';
import { defaultOrganizationId } from '../src/platform/provisioning.js';

const PREFIX = 'loadtest+';
const BATCH = 500;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : null;
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('loadtest-fixtures refuses to run in production.');
  }
  const { sql: raw, db } = createDb();
  try {
    const organizationId = await defaultOrganizationId(db);

    if (process.argv.includes('--clean')) {
      const removed = await db
        .delete(users)
        .where(and(eq(users.organizationId, organizationId), like(users.email, `${PREFIX}%`)))
        .returning({ id: users.id });
      console.log(`removed ${removed.length} load-test users (accounts cascade)`);
      return;
    }

    const count = Number(arg('count') ?? '1000');
    if (!Number.isFinite(count) || count <= 0) throw new Error('pass --count <n>');

    // Pin every fixture account to a real, active product version.
    const [profile] = await db
      .select()
      .from(accountProfiles)
      .where(and(eq(accountProfiles.organizationId, organizationId), eq(accountProfiles.status, 'ACTIVE')))
      .limit(1);
    if (!profile) throw new Error('no active product to pin fixtures to; seed first');
    const [version] = await db
      .select()
      .from(accountProfileVersions)
      .where(eq(accountProfileVersions.profileId, profile.id))
      .orderBy(desc(accountProfileVersions.version))
      .limit(1);
    if (!version) throw new Error('active product has no version');

    const cfg = version.config as { rules: { accountSizeMicros: number; maxLossMicros: number } };
    const starting = cfg.rules.accountSizeMicros;
    const floor = starting - cfg.rules.maxLossMicros;

    // One hash, reused: these accounts are for read-path load, not for logging
    // in as ten thousand different people. Everything else is genuine.
    const passwordHash = await hashPassword('loadtest-not-a-real-login');
    const stamp = Date.now();
    const started = stamp;

    let made = 0;
    for (let base = 0; base < count; base += BATCH) {
      const n = Math.min(BATCH, count - base);
      const userRows = Array.from({ length: n }, (_, i) => {
        const k = base + i;
        return {
          email: `${PREFIX}${stamp}-${k}@loadtest.local`,
          passwordHash,
          displayName: `Load Test Trader ${k}`,
          role: 'TRADER',
          organizationId,
        };
      });
      const inserted = await db.insert(users).values(userRows).returning({ id: users.id });
      const accountRows = inserted.map((u, i) => ({
        userId: u.id,
        organizationId,
        profileVersionId: version.id,
        name: `Eval ${base + i}`,
        accountType: profile.accountType,
        status: 'ACTIVE',
        startingBalanceMicros: starting,
        balanceMicros: starting,
        highWaterMarkMicros: starting,
        drawdownFloorMicros: floor,
        dayStartBalanceMicros: starting,
        dayStartEquityMicros: starting,
      }));
      await db.insert(accounts).values(accountRows);
      made += n;
      if (made % 2000 === 0 || made === count) console.log(`inserted ${made}/${count}`);
    }

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), like(users.email, `${PREFIX}%`)));
    console.log(
      `done: ${made} traders in ${((Date.now() - started) / 1000).toFixed(1)}s; ${total} load-test traders total`,
    );
  } finally {
    await raw.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('fixtures failed:', err);
  process.exit(1);
});
