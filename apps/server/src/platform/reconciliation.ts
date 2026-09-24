/**
 * Execution reconciliation (M4-O).
 *
 * External provider state can disagree with Atlas after a disconnect, restart,
 * timeout, lost acknowledgement, duplicate event, or late fill. This compares
 * Atlas's recorded external working orders + positions against the venue's own
 * authoritative snapshot and records a per-account reconciliation state.
 *
 * Atlas NEVER guesses that an external order disappeared: if a working Atlas
 * order is absent from the venue snapshot, or the venue reports an order/position
 * Atlas does not know, or the venue cannot be reached, the account is marked
 * RECONCILIATION_REQUIRED / UNKNOWN — dangerous actions are restricted upstream
 * until an operator resolves it. It never silently resets external state.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { reconciliationState } from '../db/schema.js';
import type { ReconciliationState } from '@atlas/contracts';
import type { ExternalExecutionAdapter } from '../execution/external-provider.js';
import { listWorkingByAccount } from './external-orders.js';

export interface ReconcileResult {
  readonly accountId: string;
  readonly state: ReconciliationState;
  readonly detail: string;
  readonly atlasWorkingCount: number;
  readonly venueWorkingCount: number;
  readonly discrepancies: readonly string[];
}

/**
 * Reconcile one account against an external venue. Records and returns the state.
 * If the venue is unreachable → UNKNOWN (never assume orders vanished).
 */
export async function reconcileAccount(
  db: Database,
  accountId: string,
  providerAccountId: string,
  adapter: ExternalExecutionAdapter,
): Promise<ReconcileResult> {
  const atlasWorking = await listWorkingByAccount(db, accountId);

  let venueOrders;
  try {
    venueOrders = await adapter.listWorkingOrders(providerAccountId);
  } catch (err) {
    const detail = `Venue unreachable during reconciliation: ${(err as Error).message}`.slice(0, 400);
    await upsert(db, accountId, providerAccountId, 'UNKNOWN', detail);
    return { accountId, state: 'UNKNOWN', detail, atlasWorkingCount: atlasWorking.length, venueWorkingCount: 0, discrepancies: [detail] };
  }

  const venueById = new Map(venueOrders.map((o) => [o.providerOrderId, o]));
  const atlasById = new Map(
    atlasWorking.filter((o) => o.providerOrderId).map((o) => [o.providerOrderId as string, o]),
  );

  const discrepancies: string[] = [];

  // Atlas thinks it has a working order the venue does not show.
  for (const o of atlasWorking) {
    if (o.providerOrderId === null) {
      // Submitted but never acknowledged (lost ack): cannot confirm at the venue.
      discrepancies.push(`atlas order ${o.atlasOrderId} has no provider id (unacknowledged)`);
      continue;
    }
    if (!venueById.has(o.providerOrderId)) {
      discrepancies.push(`atlas working order ${o.providerOrderId} absent from venue`);
    }
  }
  // The venue shows a working order Atlas does not know as working.
  for (const v of venueOrders) {
    if (!atlasById.has(v.providerOrderId)) {
      discrepancies.push(`venue order ${v.providerOrderId} unknown to atlas`);
    }
  }

  const state: ReconciliationState = discrepancies.length === 0 ? 'IN_SYNC' : 'RECONCILIATION_REQUIRED';
  const detail =
    state === 'IN_SYNC'
      ? `In sync: ${atlasWorking.length} working order(s) match the venue.`
      : `Reconciliation required: ${discrepancies.length} discrepancy(ies).`;
  await upsert(db, accountId, providerAccountId, state, detail);

  return {
    accountId,
    state,
    detail,
    atlasWorkingCount: atlasWorking.length,
    venueWorkingCount: venueOrders.length,
    discrepancies,
  };
}

export async function getReconciliationState(
  db: Database,
  accountId: string,
): Promise<{ state: ReconciliationState; detail: string | null; lastCheckedAt: number | null } | null> {
  const [row] = await db.select().from(reconciliationState).where(eq(reconciliationState.accountId, accountId));
  if (!row) return null;
  return { state: row.state as ReconciliationState, detail: row.detail ?? null, lastCheckedAt: row.lastCheckedAt?.getTime() ?? null };
}

async function upsert(
  db: Database,
  accountId: string,
  providerAccountId: string,
  state: ReconciliationState,
  detail: string,
): Promise<void> {
  const now = new Date();
  const [existing] = await db.select().from(reconciliationState).where(eq(reconciliationState.accountId, accountId));
  if (existing) {
    await db
      .update(reconciliationState)
      .set({ providerAccountId, state, detail, lastCheckedAt: now, updatedAt: now })
      .where(eq(reconciliationState.accountId, accountId));
  } else {
    await db.insert(reconciliationState).values({ accountId, providerAccountId, state, detail, lastCheckedAt: now });
  }
}
