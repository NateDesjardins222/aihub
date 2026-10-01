/**
 * Celebrations — the authoritative feed of milestone moments worth celebrating,
 * plus per-customer "seen" acknowledgement (Experience Layer Phase 2).
 *
 * STRICT invariants:
 *  - PRESENTATION SUPPORT ONLY. This module computes NO business truth and changes
 *    NO business rule. It reads already-authoritative, already-exactly-once records
 *    (achievements, certificates, accounts) through owner-scoped queries, and stores
 *    only a "this customer has seen this event" flag.
 *  - OWNER-SCOPED. Every read resolves the caller's own customer identity; a
 *    celebration for customer B can never surface for customer A.
 *  - IDEMPOTENT DISPLAY. Each celebration has a STABLE `eventKey` (`achievement:<id>`)
 *    tied to an exactly-once achievement row. Once acknowledged it never returns in
 *    the pending feed again — so a major moment is celebrated once, not every refresh.
 *
 * The achievement row is the single source: it is issued exactly once per
 * (identity, dedupeKey) on an authoritative domain event (funded, paid payout, club
 * reached, account completed). We enrich it with the matching certificate + account
 * for the celebration's actions, but the TRIGGER is always the authoritative event.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, celebrationAcks, customerIdentities } from '../db/schema.js';
import { listAchievementsForUser, type AchievementType } from './achievements.js';
import { listCertificatesForUser } from './certificates.js';

export type CelebrationKind = 'FUNDED' | 'PAYOUT' | 'CLUB' | 'ACCOUNT_COMPLETED' | 'MILESTONE';
export type CelebrationIntensity = 'HIGH' | 'MAJOR' | 'MEDIUM';

export interface CelebrationEvent {
  /** Stable, owner-scoped key: `achievement:<achievementId>`. Used for acknowledgement. */
  eventKey: string;
  type: AchievementType;
  kind: CelebrationKind;
  intensity: CelebrationIntensity;
  /** Higher fires first in the queue (see §76 priority order). */
  priority: number;
  occurredAt: number;
  amountMicros: number | null;
  accountId: string | null;
  accountPublicId: string | null;
  accountName: string | null;
  /** The certificate to reveal/download for this moment, when one exists. */
  certificateId: string | null;
}

interface CelebrationConfig { kind: CelebrationKind; intensity: CelebrationIntensity; priority: number; certType: string | null }

/**
 * Which authoritative achievements warrant a full-screen celebration, and how big.
 * Trading activity, streaks and resets are deliberately ABSENT — we celebrate
 * verified accomplishment only (§28). Priority follows §76.
 */
const CELEBRATION_CONFIG: Partial<Record<AchievementType, CelebrationConfig>> = {
  HUNDREDK_CLUB: { kind: 'CLUB', intensity: 'HIGH', priority: 100, certType: 'HUNDREDK_CLUB' },
  ACCOUNT_COMPLETED: { kind: 'ACCOUNT_COMPLETED', intensity: 'HIGH', priority: 90, certType: 'ACCOUNT_COMPLETED' },
  FIRST_PAYOUT: { kind: 'PAYOUT', intensity: 'HIGH', priority: 80, certType: 'PAYOUT' },
  FUNDED: { kind: 'FUNDED', intensity: 'HIGH', priority: 70, certType: 'FUNDED_TRADER' },
  FIFTYK_CLUB: { kind: 'CLUB', intensity: 'MAJOR', priority: 60, certType: 'FIFTYK_CLUB' },
  TENK_CLUB: { kind: 'CLUB', intensity: 'MEDIUM', priority: 50, certType: 'TENK_CLUB' },
  FIVE_PAYOUT_CLUB: { kind: 'MILESTONE', intensity: 'MEDIUM', priority: 40, certType: null },
  PAID_25K: { kind: 'PAYOUT', intensity: 'MEDIUM', priority: 35, certType: null },
  PAID_10K: { kind: 'PAYOUT', intensity: 'MEDIUM', priority: 30, certType: null },
  PAID_5K: { kind: 'PAYOUT', intensity: 'MEDIUM', priority: 25, certType: null },
};

function metaNumber(meta: unknown, key: string): number | null {
  if (meta && typeof meta === 'object' && key in (meta as Record<string, unknown>)) {
    const v = (meta as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}
function metaString(meta: unknown, key: string): string | null {
  if (meta && typeof meta === 'object' && key in (meta as Record<string, unknown>)) {
    const v = (meta as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

async function identityForUser(db: Database, userId: string): Promise<{ id: string; organizationId: string } | null> {
  const [row] = await db
    .select({ id: customerIdentities.id, organizationId: customerIdentities.organizationId })
    .from(customerIdentities)
    .where(eq(customerIdentities.userId, userId));
  return row ?? null;
}

/**
 * The caller's UNSEEN celebration-worthy moments, highest priority first. Everything
 * is authoritative and owner-scoped; acknowledged events are filtered out.
 */
export async function listPendingCelebrations(db: Database, userId: string): Promise<CelebrationEvent[]> {
  const identity = await identityForUser(db, userId);
  if (!identity) return [];

  const [{ achievements: achs }, certs, acctRows, ackRows] = await Promise.all([
    listAchievementsForUser(db, userId),
    listCertificatesForUser(db, userId),
    db.select({ id: accounts.id, publicId: accounts.publicId, name: accounts.name }).from(accounts).where(eq(accounts.userId, userId)),
    db.select({ eventKey: celebrationAcks.eventKey }).from(celebrationAcks).where(eq(celebrationAcks.customerIdentityId, identity.id)),
  ]);

  const seen = new Set(ackRows.map((r) => r.eventKey));
  const acctById = new Map(acctRows.map((a) => [a.id, a]));
  const events: CelebrationEvent[] = [];

  for (const a of achs as Array<{ id: string; type: AchievementType; meta: unknown; earnedAt: number }>) {
    const cfg = CELEBRATION_CONFIG[a.type];
    if (!cfg) continue;
    const eventKey = `achievement:${a.id}`;
    if (seen.has(eventKey)) continue;

    const accountId = metaString(a.meta, 'accountId');
    const acct = accountId ? acctById.get(accountId) : undefined;
    // Match the moment's certificate: same cert type, preferring the same account.
    let certificateId: string | null = null;
    if (cfg.certType) {
      const candidates = (certs as Array<{ id: string; type: string; accountId: string | null; issuedAt: number }>)
        .filter((c) => c.type === cfg.certType);
      const exact = accountId ? candidates.find((c) => c.accountId === accountId) : undefined;
      certificateId = (exact ?? candidates.sort((x, y) => y.issuedAt - x.issuedAt)[0])?.id ?? null;
    }

    events.push({
      eventKey,
      type: a.type,
      kind: cfg.kind,
      intensity: cfg.intensity,
      priority: cfg.priority,
      occurredAt: a.earnedAt,
      amountMicros: metaNumber(a.meta, 'amountMicros') ?? metaNumber(a.meta, 'traderShareMicros') ?? metaNumber(a.meta, 'milestoneMicros'),
      accountId: accountId ?? null,
      accountPublicId: acct?.publicId ?? null,
      accountName: acct?.name ?? null,
      certificateId,
    });
  }

  events.sort((x, y) => y.priority - x.priority || y.occurredAt - x.occurredAt);
  return events;
}

/** eventKeys are `achievement:<uuid>`; bound the shape so we never store junk. */
const EVENT_KEY_RE = /^achievement:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mark a celebration seen for this customer. Idempotent (unique on
 * (identity, eventKey)); a bad key or an unknown customer is a quiet no-op so a
 * client can never force-store an arbitrary ack. Returns true when newly stored.
 */
export async function acknowledgeCelebration(db: Database, userId: string, eventKey: string): Promise<boolean> {
  if (typeof eventKey !== 'string' || !EVENT_KEY_RE.test(eventKey)) return false;
  const identity = await identityForUser(db, userId);
  if (!identity) return false;
  const [row] = await db
    .insert(celebrationAcks)
    .values({ organizationId: identity.organizationId, customerIdentityId: identity.id, eventKey })
    .onConflictDoNothing({ target: [celebrationAcks.customerIdentityId, celebrationAcks.eventKey] })
    .returning();
  return Boolean(row);
}
