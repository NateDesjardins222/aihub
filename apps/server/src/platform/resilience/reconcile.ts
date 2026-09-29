/**
 * Independent reconciliation oracle (Engineering Resilience Phase 2, Parts X–XI, XXII).
 *
 * READ-ONLY. Recomputes each account's authoritative state a SECOND, independent
 * way — folding the raw `executions` history through the pure `applyFill` reducer —
 * and compares it to the persisted `positions`, `accounts` and `payout_ledger`
 * rows. This is an integrity ORACLE, not a second production position engine: it
 * never writes, and it exists to catch any silent divergence between execution
 * provenance and stored money.
 *
 * Why recompute realized P&L rather than read it: `executions.realized_pnl_micros`
 * is intentionally always 0 (the engine books realized P&L on the position and on
 * the account, not per execution — see the transaction map). So realized P&L is
 * derived here from the (side, qty, priceTicks) sequence, exactly as the engine's
 * matcher does, giving a genuinely independent check.
 *
 * All money is integer micro-dollars; all comparisons are EXACT (no tolerance).
 */
import { and, asc, eq } from 'drizzle-orm';
import { applyFill, flatPosition, type PositionState } from '@atlas/core';
import { requireInstrument } from '@atlas/instruments';
import type { Database } from '../../db/client.js';
import { accounts, executions, payoutLedger, positions } from '../../db/schema.js';

export interface ReconLine {
  readonly kind:
    | 'POSITION_QTY'
    | 'POSITION_COST_BASIS'
    | 'POSITION_REALIZED'
    | 'POSITION_FEES'
    | 'ACCOUNT_REALIZED'
    | 'ACCOUNT_FEES'
    | 'BALANCE_IDENTITY'
    | 'LEDGER_ARITHMETIC';
  readonly entity: string; // accountId or accountId:symbol or ledgerRowId
  readonly expected: number;
  readonly actual: number;
  readonly delta: number;
  readonly detail?: string;
}

export interface ReconstructedPosition {
  readonly symbol: string;
  readonly qty: number;
  readonly costBasisMicros: number;
  readonly realizedPnlMicros: number;
  readonly feesMicros: number;
}

interface ExecRow {
  symbol: string;
  side: string;
  qty: number;
  priceTicks: number;
  feesMicros: number;
  seq: number;
}

/**
 * Fold an execution history (already ordered by seq) for ONE symbol through the
 * pure reducer. Returns the independently-derived terminal position + realized
 * P&L + fees. This is the same math the matcher uses, applied to stored fills.
 */
export function reconstructPositionFromExecutions(symbol: string, execs: readonly ExecRow[]): ReconstructedPosition {
  const spec = requireInstrument(symbol);
  let state: PositionState = flatPosition(symbol);
  for (const e of execs) {
    const signedQty = e.side === 'BUY' ? e.qty : -e.qty;
    const r = applyFill(spec, state, {
      signedQty,
      priceTicks: e.priceTicks,
      feesMicros: e.feesMicros,
      exchangeTs: e.seq, // ordering only; timestamps not needed for the arithmetic
    });
    state = r.position;
  }
  return {
    symbol,
    qty: state.qty,
    costBasisMicros: state.costBasisMicros,
    realizedPnlMicros: state.realizedPnlMicros,
    feesMicros: state.feesMicros,
  };
}

/** All symbols the account has ever executed in, with their fills in seq order. */
async function execHistoryBySymbol(db: Database, accountId: string): Promise<Map<string, ExecRow[]>> {
  const rows = await db
    .select({
      symbol: executions.symbol, side: executions.side, qty: executions.qty,
      priceTicks: executions.priceTicks, feesMicros: executions.feesMicros, seq: executions.seq,
    })
    .from(executions)
    .where(eq(executions.accountId, accountId))
    .orderBy(asc(executions.seq));
  const bySymbol = new Map<string, ExecRow[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }
  return bySymbol;
}

/**
 * Reconcile one account against its execution provenance and its ledger. Returns
 * one ReconLine per discrepancy (empty array = clean). Read-only.
 */
export async function reconcileAccount(db: Database, accountId: string): Promise<ReconLine[]> {
  const out: ReconLine[] = [];
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!acct) return out;

  const hist = await execHistoryBySymbol(db, accountId);
  const storedPositions = await db.select().from(positions).where(eq(positions.accountId, accountId));
  const storedBySymbol = new Map(storedPositions.map((p) => [p.symbol, p]));

  let sumRealized = 0;
  let sumFees = 0;
  for (const [symbol, execs] of hist) {
    const recon = reconstructPositionFromExecutions(symbol, execs);
    sumRealized += recon.realizedPnlMicros;
    sumFees += recon.feesMicros;
    const stored = storedBySymbol.get(symbol);
    // A flat reconstructed position may legitimately have no stored row.
    if (!stored) {
      if (recon.qty !== 0) {
        out.push({ kind: 'POSITION_QTY', entity: `${accountId}:${symbol}`, expected: recon.qty, actual: 0, delta: recon.qty, detail: 'non-flat reconstructed position has no stored row' });
      }
      continue;
    }
    if (stored.qty !== recon.qty) out.push({ kind: 'POSITION_QTY', entity: `${accountId}:${symbol}`, expected: recon.qty, actual: stored.qty, delta: stored.qty - recon.qty });
    if (stored.costBasisMicros !== recon.costBasisMicros) out.push({ kind: 'POSITION_COST_BASIS', entity: `${accountId}:${symbol}`, expected: recon.costBasisMicros, actual: stored.costBasisMicros, delta: stored.costBasisMicros - recon.costBasisMicros });
    if (stored.realizedPnlMicros !== recon.realizedPnlMicros) out.push({ kind: 'POSITION_REALIZED', entity: `${accountId}:${symbol}`, expected: recon.realizedPnlMicros, actual: stored.realizedPnlMicros, delta: stored.realizedPnlMicros - recon.realizedPnlMicros });
  }

  // Account-level realized/fees must equal the sum across symbols.
  if (acct.realizedPnlMicros !== sumRealized) out.push({ kind: 'ACCOUNT_REALIZED', entity: accountId, expected: sumRealized, actual: acct.realizedPnlMicros, delta: acct.realizedPnlMicros - sumRealized });
  if (acct.feesMicros !== sumFees) out.push({ kind: 'ACCOUNT_FEES', entity: accountId, expected: sumFees, actual: acct.feesMicros, delta: acct.feesMicros - sumFees });

  // Balance identity: balance = starting + realized - fees - net payout movement.
  // Net payout movement = DEBIT (money out) − REVERSAL (money restored). SETTLEMENT
  // moves no balance by construction.
  const ledger = await db.select().from(payoutLedger).where(eq(payoutLedger.accountId, accountId));
  let netPayout = 0;
  for (const l of ledger) {
    if (l.entryType === 'DEBIT') netPayout += l.amountMicros;
    else if (l.entryType === 'REVERSAL') netPayout -= l.amountMicros;
    // Per-row ledger arithmetic (mirrors the integrity check, exact).
    const ok =
      (l.entryType === 'DEBIT' && l.balanceAfterMicros === l.balanceBeforeMicros - l.amountMicros) ||
      (l.entryType === 'REVERSAL' && l.balanceAfterMicros === l.balanceBeforeMicros + l.amountMicros) ||
      (l.entryType === 'SETTLEMENT' && l.balanceAfterMicros === l.balanceBeforeMicros);
    if (!ok) out.push({ kind: 'LEDGER_ARITHMETIC', entity: l.id, expected: 0, actual: 1, delta: 1, detail: `${l.entryType} row violates balance arithmetic` });
  }
  const expectedBalance = acct.startingBalanceMicros + acct.realizedPnlMicros - acct.feesMicros - netPayout;
  if (acct.balanceMicros !== expectedBalance) {
    out.push({ kind: 'BALANCE_IDENTITY', entity: accountId, expected: expectedBalance, actual: acct.balanceMicros, delta: acct.balanceMicros - expectedBalance, detail: 'balance <> starting + realized - fees - net payout' });
  }
  return out;
}

/** Reconcile a set of accounts; returns a flat list of all discrepancies. */
export async function reconcileAccounts(db: Database, accountIds: readonly string[]): Promise<ReconLine[]> {
  const all: ReconLine[] = [];
  for (const id of accountIds) all.push(...(await reconcileAccount(db, id)));
  return all;
}
