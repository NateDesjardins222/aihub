/**
 * Data-integrity checks (Engineering Resilience Phase 1, Part XXXVI).
 *
 * READ-ONLY corruption detectors for the authoritative money/lifecycle state.
 * These answer "has any invariant become false in the database?" and are meant to
 * be run during release validation and, later, on a schedule. They DETECT; they
 * never repair (Part XXXVI: "Do not create destructive auto-repair. Detection
 * first."). Every query is a plain SELECT; nothing here mutates.
 *
 * Each detector maps to an entry in BACKEND_INVARIANT_LEDGER.md. A clean database
 * returns an empty findings array from `runIntegrityChecks`.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';

export type IntegritySeverity = 'P0' | 'P1' | 'P2';

export interface IntegrityFinding {
  /** Stable machine key for the invariant that was violated. */
  check: string;
  severity: IntegritySeverity;
  /** How many rows violate it. */
  count: number;
  /** A human sentence naming the invariant. */
  description: string;
  /** Up to a few offending identifiers, for triage (never secrets). */
  sample: string[];
}

/** The active-account cap (mirrors account-limit.ts ACTIVE definition). */
const MAX_ACTIVE_ACCOUNTS = 5;
const MAX_PAID_CYCLES = 5;

interface CheckDef {
  check: string;
  severity: IntegritySeverity;
  description: string;
  /** Returns one row per violation with a `key` text column for the sample. */
  query: ReturnType<typeof sql>;
}

function defs(): CheckDef[] {
  return [
    {
      check: 'ACTIVE_ACCOUNTS_OVER_CAP',
      severity: 'P0',
      description: `A verified identity holds more than ${MAX_ACTIVE_ACCOUNTS} active (EVALUATION/FUNDED_SIM, ACTIVE|PENDING, un-archived) accounts.`,
      query: sql`
        SELECT user_id::text AS key, count(*) AS n
        FROM accounts
        WHERE account_type IN ('EVALUATION','FUNDED_SIM')
          AND status IN ('ACTIVE','PENDING')
          AND archived_at IS NULL
        GROUP BY user_id
        HAVING count(*) > ${MAX_ACTIVE_ACCOUNTS}`,
    },
    {
      check: 'PAID_PAYOUT_CYCLES_OVER_MAX',
      severity: 'P0',
      description: `An account has more than ${MAX_PAID_CYCLES} PAID payout requests.`,
      query: sql`
        SELECT account_id::text AS key, count(*) AS n
        FROM payout_requests
        WHERE state = 'PAID'
        GROUP BY account_id
        HAVING count(*) > ${MAX_PAID_CYCLES}`,
    },
    {
      check: 'DUPLICATE_FUNDED_SUCCESSOR',
      severity: 'P0',
      description: 'One evaluation qualification is linked to more than one funded account, or one funded account is claimed by more than one qualification.',
      query: sql`
        SELECT funded_account_id::text AS key, count(*) AS n
        FROM account_qualifications
        WHERE funded_account_id IS NOT NULL
        GROUP BY funded_account_id
        HAVING count(*) > 1`,
    },
    {
      check: 'DUPLICATE_RESET_SUCCESSOR',
      severity: 'P0',
      description: 'One failed account has more than one reset successor account.',
      query: sql`
        SELECT reset_of_account_id::text AS key, count(*) AS n
        FROM accounts
        WHERE reset_of_account_id IS NOT NULL
        GROUP BY reset_of_account_id
        HAVING count(*) > 1`,
    },
    {
      check: 'DRAWDOWN_FLOOR_ABOVE_HWM',
      severity: 'P1',
      description: 'An account drawdown floor sits above its high-water mark (impossible; a corrupted or regressed floor).',
      query: sql`
        SELECT id::text AS key, 1 AS n
        FROM accounts
        WHERE drawdown_floor_micros > high_water_mark_micros`,
    },
    {
      check: 'NEGATIVE_DRAWDOWN_FLOOR',
      severity: 'P1',
      description: 'An account drawdown floor is negative.',
      query: sql`
        SELECT id::text AS key, 1 AS n
        FROM accounts
        WHERE drawdown_floor_micros < 0`,
    },
    {
      check: 'PHANTOM_POSITION',
      severity: 'P1',
      description: 'A non-flat position exists for an account/symbol with no executions to justify it.',
      query: sql`
        SELECT p.id::text AS key, 1 AS n
        FROM positions p
        WHERE p.qty <> 0
          AND NOT EXISTS (
            SELECT 1 FROM executions e
            WHERE e.account_id = p.account_id AND e.symbol = p.symbol)`,
    },
    {
      check: 'PAYOUT_LEDGER_ARITHMETIC',
      severity: 'P0',
      description: 'A payout ledger entry does not satisfy balance_after = balance_before - amount (DEBIT) / + amount (REVERSAL); SETTLEMENT must not move balance.',
      query: sql`
        SELECT id::text AS key, 1 AS n
        FROM payout_ledger
        WHERE (entry_type = 'DEBIT'      AND balance_after_micros <> balance_before_micros - amount_micros)
           OR (entry_type = 'REVERSAL'   AND balance_after_micros <> balance_before_micros + amount_micros)
           OR (entry_type = 'SETTLEMENT' AND balance_after_micros <> balance_before_micros)`,
    },
    {
      check: 'APPROVED_PAYOUT_WITHOUT_DEBIT',
      severity: 'P0',
      description: 'A payout request in APPROVED/PROCESSING/PAID has no DEBIT ledger row (money left an account with no ledger provenance).',
      query: sql`
        SELECT r.id::text AS key, 1 AS n
        FROM payout_requests r
        WHERE r.state IN ('APPROVED','PROCESSING','PAID')
          AND NOT EXISTS (
            SELECT 1 FROM payout_ledger l
            WHERE l.payout_request_id = r.id AND l.entry_type = 'DEBIT')`,
    },
    {
      // Resilience Phase 2 (RES-P2-1): a definitively-failed payout debited the
      // balance at approval; the debit must be compensated by a REVERSAL. A FAILED
      // request that still carries a DEBIT with no REVERSAL means a trader's
      // balance is reduced for money that was never paid — stranded, and (before
      // the failPayout reversal fix) undetectable. failPayout now writes the
      // REVERSAL atomically, so this detects only a pre-fix or externally-mutated row.
      check: 'FAILED_PAYOUT_DEBIT_NOT_REVERSED',
      severity: 'P0',
      description: 'A FAILED payout request has a DEBIT with no compensating REVERSAL — the account balance was debited for money that was never paid.',
      query: sql`
        SELECT r.id::text AS key, 1 AS n
        FROM payout_requests r
        WHERE r.state = 'FAILED'
          AND EXISTS (SELECT 1 FROM payout_ledger d WHERE d.payout_request_id = r.id AND d.entry_type = 'DEBIT')
          AND NOT EXISTS (SELECT 1 FROM payout_ledger v WHERE v.payout_request_id = r.id AND v.entry_type = 'REVERSAL')`,
    },
  ];
}

/**
 * Run every integrity check. Returns one finding per violated invariant (empty on
 * a clean database). Read-only. `organizationId` is accepted for future scoping but
 * the checks are global by design (a corruption anywhere is a finding).
 */
export async function runIntegrityChecks(db: Database): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  for (const def of defs()) {
    const res = await db.execute(def.query);
    const rows = (res as unknown as { rows?: Array<{ key: string }> }).rows ?? (res as unknown as Array<{ key: string }>);
    const list = Array.isArray(rows) ? rows : [];
    if (list.length > 0) {
      findings.push({
        check: def.check,
        severity: def.severity,
        count: list.length,
        description: def.description,
        sample: list.slice(0, 5).map((r) => String(r.key)),
      });
    }
  }
  return findings;
}

/** The stable list of check keys, for documentation/coverage assertions. */
export function integrityCheckKeys(): string[] {
  return defs().map((d) => d.check);
}
