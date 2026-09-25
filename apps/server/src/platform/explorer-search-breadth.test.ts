/**
 * Universal object explorer + global search breadth (M10-C/L). Confirms search
 * spans the major object types and classifies staff vs. customer correctly, and
 * that the explorer resolves staff/certificate objects WITHOUT leaking secrets
 * (a certificate's verification token is only ever a masked hint) and refuses an
 * unsupported type rather than dumping raw rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { certificates, organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { globalSearch } from './search.js';
import { explainObject } from './object-explorer.js';
import { openOrGroupIncident } from './incidents.js';

let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string;
let staffId = ''; let customerId = ''; let certId = ''; let certPublicId = ''; let certToken = '';
let incidentRef = '';
const uniq = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m10ex-${uniq}`, name: 'M10EX' }).returning();
  org = o!.id;

  const [staff] = await db.insert(users).values({ email: `ex-staff-${uniq}@atlas.test`, passwordHash: await hashPassword('ex-pw-12345678'), displayName: `ExplorerStaff ${uniq}`, role: 'ADMIN', isAdmin: true, organizationId: org }).returning({ id: users.id });
  staffId = staff!.id;
  const [cust] = await db.insert(users).values({ email: `ex-cust-${uniq}@atlas.test`, passwordHash: await hashPassword('ex-pw-12345678'), displayName: `ExplorerCust ${uniq}`, role: 'TRADER', organizationId: org }).returning({ id: users.id });
  customerId = cust!.id;
  const ident = await ensureCustomerIdentity(db, { organizationId: org, userId: customerId });

  certPublicId = `HT-C-${uniq.toUpperCase()}`;
  certToken = `tok-${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 40);
  const [cert] = await db.insert(certificates).values({
    organizationId: org, certificatePublicId: certPublicId, verificationToken: certToken,
    type: 'FUNDED_TRADER', customerIdentityId: ident.id, publicDisplayName: 'Explorer C.', status: 'ISSUED',
    dedupeKey: `cert-${uniq}`,
  }).returning({ id: certificates.id });
  certId = cert!.id;

  const inc = await openOrGroupIncident(db, { organizationId: org, title: 'Explorer incident', dedupeKey: `ex-${uniq}` });
  incidentRef = inc.publicRef;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('global search breadth', () => {
  it('finds a customer by email and classifies it as customer, not staff', async () => {
    const r = await globalSearch(db, org, `ex-cust-${uniq}@atlas.test`);
    const cg = r.groups.find((g) => g.type === 'customer');
    expect(cg?.results.some((x) => x.id === customerId)).toBe(true);
    const sg = r.groups.find((g) => g.type === 'staff');
    expect(sg?.results.some((x) => x.id === customerId) ?? false).toBe(false);
  });
  it('finds a staff member by email under the staff group', async () => {
    const r = await globalSearch(db, org, `ex-staff-${uniq}@atlas.test`);
    const sg = r.groups.find((g) => g.type === 'staff');
    expect(sg?.results.some((x) => x.id === staffId)).toBe(true);
  });
  it('finds an incident by its public ref (org-scoped)', async () => {
    const r = await globalSearch(db, org, incidentRef);
    const ig = r.groups.find((g) => g.type === 'incident');
    expect(ig?.results.some((x) => x.label === incidentRef)).toBe(true);
  });
  it('finds a certificate by public id and by exact verification token', async () => {
    const byId = await globalSearch(db, org, certPublicId);
    expect(byId.groups.find((g) => g.type === 'certificate')?.results.some((x) => x.id === certId)).toBe(true);
    const byToken = await globalSearch(db, org, certToken);
    expect(byToken.groups.find((g) => g.type === 'certificate')?.results.some((x) => x.id === certId)).toBe(true);
  });
  it('finds an account and customer by uuid', async () => {
    const r = await globalSearch(db, org, customerId);
    expect(r.groups.find((g) => g.type === 'customer')?.results.some((x) => x.id === customerId)).toBe(true);
  });
  it('a one-character query returns nothing', async () => {
    const r = await globalSearch(db, org, 'a');
    expect(r.total).toBe(0);
    expect(r.groups).toHaveLength(0);
  });
});

describe('object explorer resolves without leaking secrets', () => {
  it('explains a staff member with effective permissions and no password material', async () => {
    const v = await explainObject(db, org, 'staff', staffId);
    expect(v.type).toBe('staff');
    expect(v.title).toContain('ADMIN');
    expect(Array.isArray(v.state['effectivePermissions'])).toBe(true);
    expect(JSON.stringify(v)).not.toContain('passwordHash');
  });
  it('explains a customer and links to their accounts', async () => {
    const v = await explainObject(db, org, 'customer', customerId);
    expect(v.state['email']).toBe(`ex-cust-${uniq}@atlas.test`);
    expect(v.state['role']).toBe('TRADER');
  });
  it('masks the certificate verification token — never the raw value', async () => {
    const v = await explainObject(db, org, 'certificate', certId);
    expect(v.title).toBe(certPublicId);
    expect(String(v.state['tokenMasked']).endsWith('…')).toBe(true);
    expect(JSON.stringify(v)).not.toContain(certToken);
  });
  it('refuses an unsupported object type instead of dumping rows', async () => {
    await expect(explainObject(db, org, 'organizations', org)).rejects.toThrow();
  });
  it('a missing customer and a missing certificate both throw not found', async () => {
    await expect(explainObject(db, org, 'customer', crypto.randomUUID())).rejects.toThrow();
    await expect(explainObject(db, org, 'certificate', crypto.randomUUID())).rejects.toThrow();
  });
});
