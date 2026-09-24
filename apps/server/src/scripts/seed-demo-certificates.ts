/**
 * Dev/browser-acceptance seed: issue + render a few certificates for the demo
 * trader so the Certificate Vault has content to exercise. NOT a product backdoor
 * — it calls the same issue + render domain the recognition engine uses, and it is
 * only ever run manually against a dev database. Refuses to run when NODE_ENV is
 * production.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { defaultOrganizationId } from '../platform/provisioning.js';
import { ensureCustomerIdentity } from '../platform/customer-identity.js';
import { issueCertificate } from '../platform/certificates.js';
import { renderCertificate } from '../platform/certificate-render-service.js';

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('refusing to seed certificates in production');
  const email = process.argv[2] ?? 'demo@atlasfutures.local';
  const { db } = getDb();
  const organizationId = await defaultOrganizationId(db);
  const [u] = await db.select().from(users).where(eq(users.email, email));
  if (!u) throw new Error(`no user ${email}`);
  await ensureCustomerIdentity(db, { organizationId, userId: u.id });

  const specs = [
    { type: 'FUNDED_TRADER' as const, dedupeKey: `seed:funded:${u.id}`, amountMicros: 50_000_000_000, milestoneValueMicros: null },
    { type: 'PAYOUT' as const, dedupeKey: `seed:payout:${u.id}:1`, amountMicros: 1_700_000_000, milestoneValueMicros: null },
    { type: 'TENK_CLUB' as const, dedupeKey: `seed:tenk:${u.id}`, amountMicros: null, milestoneValueMicros: 10_000_000_000 },
  ];
  for (const s of specs) {
    const cert = await issueCertificate(db, { organizationId, userId: u.id, accountId: null, type: s.type, dedupeKey: s.dedupeKey, amountMicros: s.amountMicros, milestoneValueMicros: s.milestoneValueMicros });
    if (cert) {
      const outcome = await renderCertificate(db, cert.id);
      console.log(`seeded ${s.type} ${cert.certificatePublicId} -> ${outcome}`);
    }
  }
  console.log('done');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
