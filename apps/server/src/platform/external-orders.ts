/**
 * External order store + state machine (M4-N).
 *
 * Persists the lifecycle of an order Atlas sent to an external venue, the
 * Atlas↔provider id linkage, and an append-only audit of execution reports.
 * Atlas ids are canonical; provider ids are stored separately. Exactly-once on
 * the idempotency key: a retried command reuses the existing row rather than
 * creating a second external order. Duplicate venue reports are suppressed by a
 * dedupe key. A transport success is NOT a fill — state advances only on reports.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { externalExecutionEvents, externalOrders } from '../db/schema.js';
import type { ExternalOrderState, ExternalOrderView } from '@atlas/contracts';

const WORKING_STATES: ExternalOrderState[] = ['PENDING_SUBMIT', 'SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'PENDING_CANCEL'];

function toView(row: typeof externalOrders.$inferSelect): ExternalOrderView {
  return {
    atlasOrderId: row.atlasOrderId,
    providerOrderId: row.providerOrderId ?? null,
    accountId: row.accountId,
    providerAccountId: row.providerAccountId ?? null,
    symbol: row.symbol,
    contractCode: row.contractCode ?? null,
    requestedQty: row.requestedQty,
    filledQty: row.filledQty,
    remainingQty: Math.max(0, row.requestedQty - row.filledQty),
    avgFillPrice: row.avgFillPrice ?? null,
    state: row.state as ExternalOrderState,
    providerStatus: row.providerStatus ?? null,
    submittedAt: row.submittedAt?.getTime() ?? null,
    lastEventAt: row.lastEventAt?.getTime() ?? null,
  };
}

export interface RecordExternalOrderInput {
  organizationId: string;
  accountId: string;
  atlasOrderId: string;
  idempotencyKey: string;
  providerAccountId: string | null;
  symbol: string;
  contractCode: string | null;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT';
  requestedQty: number;
}

/**
 * Record a PENDING_SUBMIT external order exactly once. A retry with the same
 * idempotency key returns the existing row (no second order). Returns the view
 * plus whether it was a fresh insert.
 */
export async function recordExternalOrder(
  db: Database,
  input: RecordExternalOrderInput,
): Promise<{ order: ExternalOrderView; created: boolean; id: string }> {
  const [inserted] = await db
    .insert(externalOrders)
    .values({
      organizationId: input.organizationId,
      accountId: input.accountId,
      atlasOrderId: input.atlasOrderId,
      providerAccountId: input.providerAccountId,
      symbol: input.symbol,
      contractCode: input.contractCode,
      side: input.side,
      orderType: input.orderType,
      requestedQty: input.requestedQty,
      state: 'PENDING_SUBMIT',
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: externalOrders.idempotencyKey })
    .returning();

  if (inserted) return { order: toView(inserted), created: true, id: inserted.id };

  const [existing] = await db
    .select()
    .from(externalOrders)
    .where(eq(externalOrders.idempotencyKey, input.idempotencyKey));
  return { order: toView(existing!), created: false, id: existing!.id };
}

/** Record the transport acknowledgement: link the provider order id and advance. */
export async function markSubmitted(
  db: Database,
  id: string,
  providerOrderId: string | null,
  state: ExternalOrderState,
): Promise<void> {
  await db
    .update(externalOrders)
    .set({ providerOrderId, state, submittedAt: new Date(), updatedAt: new Date() })
    .where(eq(externalOrders.id, id));
}

/**
 * Apply an async execution report. Deduped by `dedupeKey`; state, filledQty and
 * avgFillPrice advance monotonically-ish (a fill never reduces filledQty). Every
 * accepted report is appended to the audit trail. Returns false if the report was
 * a duplicate (suppressed).
 */
export async function applyExecutionReport(
  db: Database,
  input: {
    externalOrderId: string;
    providerOrderId: string | null;
    state: ExternalOrderState;
    filledQty: number;
    lastFillQty: number;
    avgFillPrice: number | null;
    providerStatus: string;
    eventTs: number;
    dedupeKey?: string | null;
  },
): Promise<boolean> {
  // Duplicate suppression.
  if (input.dedupeKey) {
    const [dup] = await db
      .select({ id: externalExecutionEvents.id })
      .from(externalExecutionEvents)
      .where(eq(externalExecutionEvents.dedupeKey, input.dedupeKey));
    if (dup) return false;
  }

  const [order] = await db.select().from(externalOrders).where(eq(externalOrders.id, input.externalOrderId));
  if (!order) return false;

  await db.insert(externalExecutionEvents).values({
    externalOrderId: input.externalOrderId,
    providerOrderId: input.providerOrderId,
    state: input.state,
    filledQty: input.filledQty,
    lastFillQty: input.lastFillQty,
    avgFillPrice: input.avgFillPrice,
    providerStatus: input.providerStatus,
    eventTs: new Date(input.eventTs),
    dedupeKey: input.dedupeKey ?? null,
  });

  // A fill count never goes backwards from a stale/duplicate report.
  const filledQty = Math.max(order.filledQty, input.filledQty);
  await db
    .update(externalOrders)
    .set({
      state: input.state,
      filledQty,
      avgFillPrice: input.avgFillPrice ?? order.avgFillPrice,
      providerStatus: input.providerStatus,
      providerOrderId: input.providerOrderId ?? order.providerOrderId,
      lastEventAt: new Date(input.eventTs),
      updatedAt: new Date(),
    })
    .where(eq(externalOrders.id, input.externalOrderId));
  return true;
}

/** Mark an external order UNKNOWN (e.g. a lost acknowledgement / timeout). */
export async function markUnknown(db: Database, id: string, reason: string): Promise<void> {
  await db
    .update(externalOrders)
    .set({ state: 'UNKNOWN', providerStatus: reason.slice(0, 60), updatedAt: new Date() })
    .where(eq(externalOrders.id, id));
}

export async function getByAtlasOrderId(db: Database, atlasOrderId: string): Promise<ExternalOrderView | null> {
  const [row] = await db.select().from(externalOrders).where(eq(externalOrders.atlasOrderId, atlasOrderId));
  return row ? toView(row) : null;
}

export async function listByAccount(db: Database, accountId: string, limit = 50): Promise<ExternalOrderView[]> {
  const rows = await db
    .select()
    .from(externalOrders)
    .where(eq(externalOrders.accountId, accountId))
    .orderBy(desc(externalOrders.createdAt))
    .limit(limit);
  return rows.map(toView);
}

export async function listWorkingByAccount(db: Database, accountId: string): Promise<ExternalOrderView[]> {
  const rows = await db
    .select()
    .from(externalOrders)
    .where(and(eq(externalOrders.accountId, accountId), inArray(externalOrders.state, WORKING_STATES)));
  return rows.map(toView);
}
