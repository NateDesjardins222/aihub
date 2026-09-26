/**
 * Create the FIRST production operator, out of band (Phase 12.5).
 *
 * The development seed refuses to run in production because it uses known
 * credentials; this is the safe replacement for creating the first owner on a
 * real deployment. It is intentionally not an HTTP route: it runs on the server,
 * once, by the operator, and creates exactly one SUPER_ADMIN.
 *
 * Usage (nothing is hard-coded; credentials come from the environment and are
 * never echoed):
 *
 *   ALLOW_OWNER_BOOTSTRAP=true \
 *   BOOTSTRAP_OWNER_EMAIL=you@yourfirm.com \
 *   BOOTSTRAP_OWNER_PASSWORD='<a strong password>' \
 *   BOOTSTRAP_OWNER_NAME='Your Name' \
 *   pnpm --filter @atlas/server exec tsx scripts/bootstrap-owner.ts
 *
 * It refuses unless ALLOW_OWNER_BOOTSTRAP=true (so it can never run by accident),
 * refuses if an owner already exists (one-time only), and prints only the created
 * email — never the password. First login should immediately enroll MFA.
 */
import { createDb } from '../src/db/client.js';
import { bootstrapOwner, OwnerBootstrapError } from '../src/platform/owner-bootstrap.js';

async function main(): Promise<void> {
  if (process.env['ALLOW_OWNER_BOOTSTRAP'] !== 'true') {
    console.error(
      'Refusing to bootstrap: set ALLOW_OWNER_BOOTSTRAP=true to confirm you intend to create the first operator.',
    );
    process.exit(78); // EX_CONFIG
  }
  const email = process.env['BOOTSTRAP_OWNER_EMAIL'];
  const password = process.env['BOOTSTRAP_OWNER_PASSWORD'];
  const displayName = process.env['BOOTSTRAP_OWNER_NAME'];
  if (!email || !password) {
    console.error('BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD are required.');
    process.exit(78);
  }

  const { sql, db } = createDb();
  try {
    const result = await bootstrapOwner(db, { email, password, displayName });
    // Never print the password. Only the identifying facts.
    console.log(`Owner created: ${result.email} (SUPER_ADMIN).`);
    console.log('Next step: sign in and enroll MFA immediately at /auth/mfa/enroll/begin.');
  } catch (err) {
    if (err instanceof OwnerBootstrapError) {
      console.error(`Bootstrap refused (${err.code}): ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('bootstrap failed:', err);
  process.exit(1);
});
