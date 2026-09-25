/**
 * The durable payout-operations worker (Milestone 8).
 *
 * It resumes work no single request can guarantee: submitting PAYABLE payouts a
 * treasury/breaker delay left behind, retrying transient provider failures with
 * the SAME idempotency key, and periodically reconciling SUBMITTED/PROCESSING
 * payouts against the provider (webhooks are best-effort). Claims are disjoint
 * (`FOR UPDATE SKIP LOCKED`) and `submitPayable` re-locks the op row and no-ops if
 * it is no longer PAYABLE, so two workers can never double-submit. A server restart
 * simply picks the durable rows back up.
 */
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { systemClock, type Clock } from './clock.js';
import { reconcilePayout, submitPayable } from './payout-operations.js';
import { payoutOperations } from '../db/schema.js';
import { getOpsConfig } from './payout-ops-config.js';
import { markSlaBreachIfNeeded } from './payout-ops-metrics.js';

/** Claim up to `limit` PAYABLE payouts and submit each. Returns the count submitted. */
export async function submitPayableBatch(db: Database, opts: { limit?: number; clock?: Clock } = {}): Promise<number> {
  const clock = opts.clock ?? systemClock;
  const limit = opts.limit ?? 20;
  const claimed = await db.execute(sql`
    SELECT payout_request_id FROM payout_operations
    WHERE op_state = 'PAYABLE'
    ORDER BY payable_at ASC NULLS FIRST
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `) as unknown as Array<{ payout_request_id: string }>;
  let n = 0;
  for (const row of claimed) {
    try {
      await submitPayable(db, row.payout_request_id, { clock });
      await markSlaBreachIfNeeded(db, row.payout_request_id, clock);
      n += 1;
    } catch { /* a single failure never stalls the batch */ }
  }
  return n;
}

/** Reconcile SUBMITTED/PROCESSING payouts older than the stale threshold. */
export async function reconcileStaleBatch(db: Database, organizationId: string, opts: { limit?: number; clock?: Clock } = {}): Promise<number> {
  const clock = opts.clock ?? systemClock;
  const config = await getOpsConfig(db, organizationId);
  const staleMs = (config.reconStaleThresholdSeconds ?? 900) * 1000;
  const cutoff = new Date(clock.now() - staleMs);
  const rows = await db
    .select({ id: payoutOperations.payoutRequestId })
    .from(payoutOperations)
    .where(and(
      eq(payoutOperations.organizationId, organizationId),
      inArray(payoutOperations.opState, ['SUBMITTED', 'PROCESSING']),
      isNotNull(payoutOperations.submittedAt),
      lt(payoutOperations.submittedAt, cutoff),
    ))
    .orderBy(asc(payoutOperations.submittedAt))
    .limit(opts.limit ?? 20);
  let n = 0;
  for (const row of rows) {
    try { await reconcilePayout(db, row.id, { trigger: 'PERIODIC', clock }); n += 1; } catch { /* keep going */ }
  }
  return n;
}

/** A small polling worker for the running server. Tests call tick() directly. */
export class PayoutOpsWorker {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly db: Database,
    private readonly opts: { pollMs?: number; batch?: number; name?: string } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<number> {
    return submitPayableBatch(this.db, { limit: this.opts.batch ?? 20 });
  }
}
