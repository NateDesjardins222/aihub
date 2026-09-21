/**
 * The transactional outbox and its delivery worker.
 *
 * A financial mutation enqueues an outbox row in its OWN transaction, so a row
 * exists whenever the mutation committed - there is no window where truth
 * changed but the event was lost. The worker claims rows with
 * `FOR UPDATE SKIP LOCKED`, so any number of workers can drain the same table
 * and never own the same row twice. A row is marked delivered only when its
 * handler and the mark commit together; if a worker dies mid-tick the whole
 * transaction rolls back, the row unlocks, and another worker reclaims it.
 *
 * Delivery is AT-LEAST-ONCE. Consumers are idempotent (the projection recomputes
 * from authority), so a redelivery has no duplicate financial effect. On a
 * handler error the row backs off (`available_at`) and retries; after
 * `maxAttempts` it is parked as `dead_letter` rather than looping forever.
 */
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type postgres from 'postgres';
import { outboxEvents } from '../db/schema.js';

export interface OutboxEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly stateVersion: number | null;
  readonly payload: unknown;
  readonly attempts: number;
}

/** Enqueue an event inside the caller's transaction (pass the tx, not the pool). */
export async function enqueueOutbox(
  tx: Database,
  event: {
    aggregateId: string;
    type: string;
    stateVersion?: number | null;
    aggregateType?: string;
    payload?: unknown;
  },
): Promise<void> {
  await tx.insert(outboxEvents).values({
    aggregateType: event.aggregateType ?? 'ACCOUNT',
    aggregateId: event.aggregateId,
    type: event.type,
    stateVersion: event.stateVersion ?? null,
    payload: (event.payload ?? null) as never,
  });
}

/** A handler runs inside the worker's claiming transaction, so its work and the
 *  delivery mark commit atomically. It must be idempotent. */
export type OutboxHandler = (tx: Database, event: OutboxEvent) => Promise<void>;

export interface OutboxWorkerOptions {
  readonly handler: OutboxHandler;
  readonly batch?: number;
  readonly pollMs?: number;
  readonly maxAttempts?: number;
  /** Backoff before a failed row is retried: min(base * 2^attempts, cap). */
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  /** Emitted (best-effort) after commit so other processes can wake. */
  readonly onDelivered?: (accountIds: string[]) => void;
  readonly name?: string;
  /** Restrict this worker to one aggregate. A worker fleet can shard this way. */
  readonly aggregateId?: string;
}

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  readonly name: string;

  constructor(
    private readonly db: Database,
    private readonly opts: OutboxWorkerOptions,
  ) {
    this.name = opts.name ?? `outbox-${process.pid}`;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const poll = this.opts.pollMs ?? 200;
    this.timer = setInterval(() => void this.tick(), poll);
    // Do not keep the process alive solely for polling.
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Claim and process one batch. Returns how many rows were delivered. Safe to
   * call concurrently from many workers: SKIP LOCKED guarantees disjoint claims.
   */
  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    const batch = this.opts.batch ?? 50;
    const maxAttempts = this.opts.maxAttempts ?? 8;
    const base = this.opts.backoffBaseMs ?? 250;
    const cap = this.opts.backoffCapMs ?? 30_000;
    const deliveredAccounts: string[] = [];

    try {
      const delivered = await this.db.transaction(async (tx) => {
        const conditions = [
          isNull(outboxEvents.deliveredAt),
          eq(outboxEvents.deadLetter, false),
          lte(outboxEvents.availableAt, new Date()),
        ];
        if (this.opts.aggregateId) {
          conditions.push(eq(outboxEvents.aggregateId, this.opts.aggregateId));
        }
        const rows = await tx
          .select()
          .from(outboxEvents)
          .where(and(...conditions))
          .orderBy(asc(outboxEvents.createdAt))
          .limit(batch)
          .for('update', { skipLocked: true });

        let count = 0;
        for (const row of rows) {
          const event: OutboxEvent = {
            id: row.id,
            aggregateType: row.aggregateType,
            aggregateId: row.aggregateId,
            type: row.type,
            stateVersion: row.stateVersion,
            payload: row.payload,
            attempts: row.attempts,
          };
          try {
            await this.opts.handler(tx as unknown as Database, event);
            await tx
              .update(outboxEvents)
              .set({ deliveredAt: new Date(), attempts: row.attempts + 1, lastError: null })
              .where(eq(outboxEvents.id, row.id));
            deliveredAccounts.push(row.aggregateId);
            count += 1;
          } catch (err) {
            const attempts = row.attempts + 1;
            const backoff = Math.min(base * 2 ** attempts, cap);
            await tx
              .update(outboxEvents)
              .set({
                attempts,
                availableAt: new Date(Date.now() + backoff),
                lastError: String((err as Error).message ?? err).slice(0, 2000),
                deadLetter: attempts >= maxAttempts,
              })
              .where(eq(outboxEvents.id, row.id));
          }
        }
        return count;
      });

      if (deliveredAccounts.length > 0 && this.opts.onDelivered) {
        // After commit, so a woken listener sees the committed projection.
        try {
          this.opts.onDelivered([...new Set(deliveredAccounts)]);
        } catch {
          /* notification is best-effort; durable state already committed */
        }
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }

  /** Drain until no due rows remain. For tests and backlog recovery. */
  async runUntilEmpty(maxTicks = 10_000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxTicks; i += 1) {
      const n = await this.tick();
      total += n;
      if (n === 0) break;
    }
    return total;
  }
}

/** Counts for observability and tests. Optionally scoped to one aggregate. */
export async function outboxStats(
  db: Database,
  aggregateId?: string,
): Promise<{ pending: number; deadLetter: number; delivered: number }> {
  const rows = await db
    .select({
      pending: sql<number>`count(*) filter (where ${outboxEvents.deliveredAt} is null and ${outboxEvents.deadLetter} = false)::int`,
      deadLetter: sql<number>`count(*) filter (where ${outboxEvents.deadLetter} = true)::int`,
      delivered: sql<number>`count(*) filter (where ${outboxEvents.deliveredAt} is not null)::int`,
    })
    .from(outboxEvents)
    .where(aggregateId ? eq(outboxEvents.aggregateId, aggregateId) : undefined);
  return rows[0] ?? { pending: 0, deadLetter: 0, delivered: 0 };
}

/**
 * Fire a PostgreSQL NOTIFY so other processes can wake and refresh. Transient by
 * design: if it is lost, the durable projection and outbox still hold the truth.
 */
export async function notifyAccountChanged(pg: postgres.Sql, accountIds: string[]): Promise<void> {
  for (const id of accountIds) {
    await pg.notify('atlas_account_changed', id).catch(() => undefined);
  }
}
