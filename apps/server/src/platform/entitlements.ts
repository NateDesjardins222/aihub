/**
 * Market-data entitlement domain (M4-S) — SOFTWARE only.
 *
 * NOT legal advice, NOT permission to redistribute, NOT an exchange agreement.
 * This is the domain Atlas will consult before serving professional real-time
 * data. Absence of an entitlement resolves to UNKNOWN, never ENTITLED — Atlas
 * does not silently serve real-time data it cannot prove it may.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { marketDataEntitlements } from '../db/schema.js';
import type {
  EntitlementDataLevel,
  EntitlementDisplayUse,
  EntitlementExchange,
  EntitlementStatus,
} from '@atlas/contracts';

/**
 * The effective entitlement status for a user + exchange at a data level. A
 * user-specific row wins over an org/exchange-wide row. No matching row → UNKNOWN.
 */
export async function entitlementStatus(
  db: Database,
  userId: string | null,
  exchange: EntitlementExchange,
  dataLevel: EntitlementDataLevel,
): Promise<EntitlementStatus> {
  const now = Date.now();
  const rows = await db
    .select()
    .from(marketDataEntitlements)
    .where(
      and(
        eq(marketDataEntitlements.exchange, exchange),
        eq(marketDataEntitlements.dataLevel, dataLevel),
        userId ? or(eq(marketDataEntitlements.userId, userId), isNull(marketDataEntitlements.userId)) : isNull(marketDataEntitlements.userId),
      ),
    );
  if (rows.length === 0) return 'UNKNOWN';

  // Prefer the user-specific row, then evaluate effectivity.
  const chosen = rows.sort((a, b) => (a.userId ? -1 : 1) - (b.userId ? -1 : 1))[0]!;
  if (chosen.effectiveAt && chosen.effectiveAt.getTime() > now) return 'PENDING';
  if (chosen.expiresAt && chosen.expiresAt.getTime() < now) return 'NOT_ENTITLED';
  return chosen.status as EntitlementStatus;
}

export interface UpsertEntitlementInput {
  organizationId: string;
  userId: string | null;
  exchange: EntitlementExchange;
  dataLevel: EntitlementDataLevel;
  displayUse?: EntitlementDisplayUse;
  status: EntitlementStatus;
  providerEntitlementRef?: string | null;
  effectiveAt?: number | null;
  expiresAt?: number | null;
}

export async function upsertEntitlement(db: Database, input: UpsertEntitlementInput): Promise<void> {
  await db.insert(marketDataEntitlements).values({
    organizationId: input.organizationId,
    userId: input.userId,
    exchange: input.exchange,
    dataLevel: input.dataLevel,
    displayUse: input.displayUse ?? 'DISPLAY',
    status: input.status,
    providerEntitlementRef: input.providerEntitlementRef ?? null,
    effectiveAt: input.effectiveAt ? new Date(input.effectiveAt) : null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  });
}
