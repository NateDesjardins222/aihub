/**
 * The bridge between the execution engine and the platform record.
 *
 * The engine already announces what it did. This subscribes to that
 * announcement and turns the parts that matter into audit rows and domain
 * events. The engine is not modified, does not import this file, and does not
 * know whether anything is listening — which is what lets payments, e-mail and
 * notifications be added later without touching the matcher.
 *
 * It is deliberately quiet. A fill is worth a record; a valuation tick, of
 * which there are thousands an hour, is not.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { recordRuleOutcome } from './account-service.js';

interface EngineLike {
  onChange(listener: (change: EngineChangeLike) => void): () => void;
}

interface EngineChangeLike {
  readonly accountId: string;
  readonly fills: ReadonlyArray<{
    id: string;
    orderId: string;
    symbol: string;
    side: string;
    qty: number;
    priceTicks: number;
    feesMicros: number;
    realizedPnlMicros: number;
    execTime: number;
  }>;
  readonly balanceMicros: number;
}

interface AccountFacts {
  readonly organizationId: string | null;
  readonly userId: string;
  readonly publicId: string;
  readonly status: string;
}

/**
 * Account facts change rarely and are read on every fill, so they are cached
 * for a few seconds. A stale organisation id on an audit row is not possible:
 * an account never changes organisation.
 */
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; facts: AccountFacts }>();

async function factsFor(db: Database, accountId: string): Promise<AccountFacts | null> {
  const cached = cache.get(accountId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.facts;
  const [row] = await db
    .select({
      organizationId: accounts.organizationId,
      userId: accounts.userId,
      publicId: accounts.publicId,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!row) return null;
  cache.set(accountId, { at: Date.now(), facts: row });
  return row;
}

/**
 * Attach the recorder to an engine.
 *
 * Returns the unsubscribe function, so a test or a shutdown can detach it.
 */
export function recordEngineActivity(db: Database, engine: EngineLike): () => void {
  /** Statuses already reported, so one breach produces one record. */
  const reported = new Map<string, string>();

  return engine.onChange((change) => {
    void (async () => {
      try {
        const facts = await factsFor(db, change.accountId);
        if (!facts) return;

        for (const fill of change.fills) {
          await recordAudit(db, {
            organizationId: facts.organizationId,
            actor: { type: 'SYSTEM', label: 'execution-engine' },
            subjectType: 'ORDER',
            subjectId: fill.orderId,
            accountId: change.accountId,
            userId: facts.userId,
            action: 'order.filled',
            newState: {
              executionId: fill.id,
              symbol: fill.symbol,
              side: fill.side,
              qty: fill.qty,
              priceTicks: fill.priceTicks,
              feesMicros: fill.feesMicros,
              realizedPnlMicros: fill.realizedPnlMicros,
              execTime: fill.execTime,
            },
          });

          await events.publish(db, {
            type: 'order.filled',
            organizationId: facts.organizationId,
            accountId: change.accountId,
            userId: facts.userId,
            payload: {
              orderId: fill.orderId,
              executionId: fill.id,
              symbol: fill.symbol,
              side: fill.side,
              qty: fill.qty,
              priceTicks: fill.priceTicks,
              realizedPnlMicros: fill.realizedPnlMicros,
            },
            occurredAt: new Date(fill.execTime),
          });
        }

        // A terminal rule outcome closes the account's current life. The engine
        // decided it; this records it once.
        const [current] = await db
          .select({ status: accounts.status, failedReason: accounts.failedReason })
          .from(accounts)
          .where(eq(accounts.id, change.accountId));
        const status = current?.status ?? null;
        if (
          (status === 'PASSED' || status === 'FAILED') &&
          reported.get(change.accountId) !== status
        ) {
          reported.set(change.accountId, status);
          cache.delete(change.accountId);
          await recordRuleOutcome(db, change.accountId, status, {
            reason: current?.failedReason ?? null,
          });
        } else if (status && status !== 'PASSED' && status !== 'FAILED') {
          reported.delete(change.accountId);
        }
      } catch {
        // Recording must never break trading. A lost audit row is reported by
        // the chain verifier; a failed fill would be a defect.
      }
    })();
  });
}
