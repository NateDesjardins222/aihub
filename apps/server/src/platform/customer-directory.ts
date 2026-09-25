/**
 * Customer Directory + tags/segments (M10-D).
 *
 * A server-side paginated directory with columns computed authoritatively
 * (lifetime spend, lifetime PAID payouts, active/funded account counts,
 * verification, tags). Aggregates are batched per page (no N+1, no full-table
 * client fetch). Customer 360 itself reuses the existing owner customer console;
 * this adds the directory, tags and dynamic segments.
 */
import { and, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, commercialOrders, customerTags, payoutRequests, users } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';

const ACTIVE = ['PENDING', 'ACTIVE', 'GOAL_REACHED', 'LOCKED'];

export interface DirectoryRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly activeAccounts: number;
  readonly fundedAccounts: number;
  readonly lifetimeSpendMicros: number;
  readonly lifetimePaidPayoutMicros: number;
  readonly tags: string[];
}

export interface DirectoryQuery {
  readonly query?: string;
  readonly segment?: string;
  readonly cursor?: string; // ISO createdAt of the last row
  readonly limit?: number;
}

export async function customerDirectory(db: Database, organizationId: string, q: DirectoryQuery = {}): Promise<{ rows: DirectoryRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const conds = [eq(users.organizationId, organizationId), eq(users.role, 'TRADER')];
  if (q.query) conds.push(or(ilike(users.email, `%${q.query}%`), ilike(users.displayName, `%${q.query}%`))!);
  if (q.cursor) conds.push(lt(users.createdAt, new Date(q.cursor)));

  const page = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName, createdAt: users.createdAt })
    .from(users)
    .where(and(...conds))
    .orderBy(desc(users.createdAt))
    .limit(limit + 1);

  const hasMore = page.length > limit;
  const rows = page.slice(0, limit);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { rows: [], nextCursor: null };

  // Batched aggregates for exactly this page's ids (bounded).
  const acctRows = await db
    .select({ userId: accounts.userId, active: sql<number>`count(*) filter (where ${accounts.status} = any(${sql.raw(`array[${ACTIVE.map((s) => `'${s}'`).join(',')}]`)}))::int`, funded: sql<number>`count(*) filter (where ${accounts.accountType} = 'FUNDED_SIM' and ${accounts.status} = any(${sql.raw(`array[${ACTIVE.map((s) => `'${s}'`).join(',')}]`)}))::int` })
    .from(accounts)
    .where(inArray(accounts.userId, ids))
    .groupBy(accounts.userId);
  const acctMap = new Map(acctRows.map((r) => [r.userId, r]));

  const spendRows = await db
    .select({ userId: commercialOrders.userId, spend: sql<number>`coalesce(sum(${commercialOrders.amountMicros}) filter (where ${commercialOrders.status} = 'COMPLETED'),0)::bigint` })
    .from(commercialOrders)
    .where(inArray(commercialOrders.userId, ids))
    .groupBy(commercialOrders.userId);
  const spendMap = new Map(spendRows.map((r) => [r.userId, Number(r.spend)]));

  const paidRows = await db
    .select({ userId: accounts.userId, paid: sql<number>`coalesce(sum(${payoutRequests.traderShareMicros}) filter (where ${payoutRequests.state} = 'PAID'),0)::bigint` })
    .from(payoutRequests)
    .innerJoin(accounts, eq(payoutRequests.accountId, accounts.id))
    .where(inArray(accounts.userId, ids))
    .groupBy(accounts.userId);
  const paidMap = new Map(paidRows.map((r) => [r.userId, Number(r.paid)]));

  const tagRows = await db.select({ userId: customerTags.userId, tag: customerTags.tag }).from(customerTags).where(inArray(customerTags.userId, ids));
  const tagMap = new Map<string, string[]>();
  for (const t of tagRows) { const a = tagMap.get(t.userId) ?? []; a.push(t.tag); tagMap.set(t.userId, a); }

  let out: DirectoryRow[] = rows.map((r) => ({
    id: r.id, email: r.email, displayName: r.displayName, createdAt: r.createdAt.toISOString(),
    activeAccounts: acctMap.get(r.id)?.active ?? 0,
    fundedAccounts: acctMap.get(r.id)?.funded ?? 0,
    lifetimeSpendMicros: spendMap.get(r.id) ?? 0,
    lifetimePaidPayoutMicros: paidMap.get(r.id) ?? 0,
    tags: tagMap.get(r.id) ?? [],
  }));

  // Factual dynamic segments (filter the page; never an accusation).
  if (q.segment === 'funded') out = out.filter((r) => r.fundedAccounts > 0);
  else if (q.segment === 'five_active') out = out.filter((r) => r.activeAccounts >= 5);
  else if (q.segment === 'never_traded') out = out.filter((r) => r.activeAccounts === 0);
  else if (q.segment === 'paid_out') out = out.filter((r) => r.lifetimePaidPayoutMicros > 0);

  const nextCursor = hasMore ? rows[rows.length - 1]!.createdAt.toISOString() : null;
  return { rows: out, nextCursor };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export async function listTags(db: Database, userId: string): Promise<string[]> {
  const rows = await db.select({ tag: customerTags.tag }).from(customerTags).where(eq(customerTags.userId, userId));
  return rows.map((r) => r.tag);
}

export async function addTag(db: Database, organizationId: string | null, userId: string, tag: string, actor: Actor): Promise<void> {
  const clean = tag.trim().toUpperCase().replace(/[^A-Z0-9_ -]/g, '').slice(0, 40);
  if (!clean) throw ApiError.badRequest('INVALID_TAG', 'A tag is required.');
  const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId));
  if (!u || u.role !== 'TRADER') throw ApiError.notFound('CUSTOMER_NOT_FOUND', 'Customer not found.');
  await db.insert(customerTags).values({ organizationId, userId, tag: clean, createdByUserId: actor.userId ?? null }).onConflictDoNothing();
  await recordAudit(db, { organizationId, actor, subjectType: 'CUSTOMER', subjectId: userId, userId, action: 'customer.tag.added', newState: { tag: clean }, reason: `tag ${clean}` });
}

export async function removeTag(db: Database, userId: string, tag: string, actor: Actor): Promise<void> {
  await db.delete(customerTags).where(and(eq(customerTags.userId, userId), eq(customerTags.tag, tag.trim().toUpperCase())));
  await recordAudit(db, { organizationId: null, actor, subjectType: 'CUSTOMER', subjectId: userId, userId, action: 'customer.tag.removed', newState: { tag }, reason: `tag ${tag}` });
}
