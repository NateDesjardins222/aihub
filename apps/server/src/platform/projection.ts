/**
 * The operational account-state read model.
 *
 * A projection is DERIVED and rebuildable: it never holds truth the database
 * does not already hold. `projectAccount` recomputes an account's snapshot from
 * authoritative state and upserts it. That design is idempotent and
 * self-correcting by construction - a projection event does not carry a delta to
 * apply, it just says "this account changed, re-snapshot it" - so a duplicate,
 * an old, or an out-of-order delivery all converge on the current truth rather
 * than corrupting the row. `state_version` is the account seq at snapshot time;
 * because seq only grows, the stored version is monotonic.
 *
 * Equity and unrealized P&L are NOT stored: they move with the market, not with
 * financial events. They are applied from live marks at read time, reusing the
 * exact function the engine uses, so a stale or missing mark reads unknown -
 * never a fabricated zero.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { requireInstrument, priceToTicks, ticksToPrice, contractResolver } from '@atlas/instruments';
import { unrealizedPnlMicros, avgEntryTicks, type PositionState } from '@atlas/core';
import type { Database } from '../db/client.js';
import { accountProjections, accounts, orders, positions, users } from '../db/schema.js';

const OPEN_ORDER_STATUSES = ['PENDING', 'ACCEPTED', 'WORKING', 'PARTIALLY_FILLED'];

/** A stored open position, enough to mark at read time. `qty` is signed. */
export interface ProjectionPosition {
  readonly symbol: string;
  readonly contractCode: string | null;
  readonly side: string;
  readonly qty: number;
  readonly costBasisMicros: number;
  readonly marketEra: string | null;
  readonly openedAt: number | null;
}

/** The market slice a projection read needs. MarketDataService satisfies it. */
export interface ProjectionMarket {
  markPrice(symbol: string): number | null;
  era(): string;
  /**
   * Exchange time of the current mark for a symbol, epoch ms, or null.
   *
   * Used only to resolve the current front-month contract when applying the
   * open-position contract lock, so the owner read and the engine read agree on
   * which contract the live feed currently represents. Optional so existing
   * ProjectionMarket implementers keep working; absent means "no roll check".
   */
  markTime?(symbol: string): number | null;
}

export type AccountProjectionRow = typeof accountProjections.$inferSelect;

/**
 * Recompute one account's projection from authoritative state and upsert it.
 *
 * Reads inside one transaction so the snapshot is internally consistent. Returns
 * the new row, or null if the account no longer exists (a deleted account's
 * projection is removed too).
 */
export async function projectAccount(
  db: Database,
  accountId: string,
): Promise<AccountProjectionRow | null> {
  return db.transaction(async (tx) => {
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
    if (!account) {
      await tx.delete(accountProjections).where(eq(accountProjections.accountId, accountId));
      return null;
    }

    const openPositions = await tx
      .select()
      .from(positions)
      .where(and(eq(positions.accountId, accountId), sql`${positions.qty} <> 0`));

    const countRows = await tx
      .select({ workingOrderCount: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.accountId, accountId), inArray(orders.status, OPEN_ORDER_STATUSES)));
    const workingOrderCount = countRows[0]?.workingOrderCount ?? 0;

    const stored: ProjectionPosition[] = openPositions.map((p) => ({
      symbol: p.symbol,
      contractCode: p.contractCode ?? null,
      side: p.side,
      qty: p.side === 'SHORT' ? -Math.abs(p.qty) : Math.abs(p.qty),
      costBasisMicros: p.costBasisMicros,
      marketEra: p.marketEra ?? null,
      openedAt: p.openedAt?.getTime() ?? null,
    }));
    const openContracts = stored.reduce((sum, p) => sum + Math.abs(p.qty), 0);

    const value = {
      accountId: account.id,
      userId: account.userId,
      organizationId: account.organizationId ?? null,
      stateVersion: account.seq,
      status: account.status,
      adminHold: account.adminHold ?? null,
      ruleStatus: account.ruleStatus,
      startingBalanceMicros: account.startingBalanceMicros,
      balanceMicros: account.balanceMicros,
      realizedPnlMicros: account.realizedPnlMicros,
      feesMicros: account.feesMicros,
      highWaterMarkMicros: account.highWaterMarkMicros,
      drawdownFloorMicros: account.drawdownFloorMicros,
      openContracts,
      workingOrderCount,
      positions: stored as never,
      lastFinancialMutationAt: account.updatedAt,
      projectionUpdatedAt: new Date(),
      consistent: true,
    };

    const [row] = await tx
      .insert(accountProjections)
      .values(value)
      .onConflictDoUpdate({
        target: accountProjections.accountId,
        // A projection only ever moves forward. If a concurrent writer already
        // wrote a newer (or equal) seq, this stale recompute is ignored - the
        // guard keeps the stored version monotonic even under duplicate or
        // out-of-order delivery.
        set: value,
        setWhere: sql`${accountProjections.stateVersion} <= ${account.seq}`,
      })
      .returning();

    // When the guard skipped the write (a newer version is already stored),
    // return whatever is stored now rather than nothing.
    if (row) return row;
    const [current] = await tx
      .select()
      .from(accountProjections)
      .where(eq(accountProjections.accountId, accountId));
    return current ?? null;
  });
}

/**
 * The valued account view: the projection plus equity and unrealized P&L applied
 * from current marks. Unknown stays unknown - one unmarkable position makes
 * equity null, exactly as the engine's own valuation does. A position is only
 * priced by the market era it was opened in.
 */
export interface ValuedProjection {
  readonly accountId: string;
  readonly userId: string;
  readonly organizationId: string | null;
  readonly stateVersion: number;
  readonly status: string;
  readonly adminHold: string | null;
  readonly ruleStatus: string;
  readonly startingBalanceMicros: number;
  readonly balanceMicros: number;
  readonly realizedPnlMicros: number;
  readonly feesMicros: number;
  readonly openContracts: number;
  readonly workingOrderCount: number;
  /** null when any open position cannot be marked. Never a fabricated zero. */
  readonly unrealizedPnlMicros: number | null;
  readonly equityMicros: number | null;
  /** Remaining loss room = equity - drawdown floor; null when equity is unknown. */
  readonly remainingLossMicros: number | null;
  readonly drawdownFloorMicros: number;
  readonly highWaterMarkMicros: number;
  readonly lastFinancialMutationAt: number | null;
  readonly projectionUpdatedAt: number;
  readonly consistent: boolean;
}

function markTicksFor(
  symbol: string,
  positionEra: string | null,
  contractCode: string | null,
  market: ProjectionMarket,
): number | null {
  // A position is only priced by the market it was opened in.
  if (positionEra !== null && positionEra !== market.era()) return null;
  // The open-position contract lock, applied identically to the engine's own
  // marking so owner and trader always agree: a position opened in a specific
  // contract is not marked once the root's front month has rolled past it.
  if (contractCode != null) {
    const markTime = market.markTime?.(symbol) ?? null;
    if (markTime !== null) {
      const current = contractResolver.contractCode(symbol, markTime);
      if (current !== null && current !== contractCode) return null;
    }
  }
  const price = market.markPrice(symbol);
  if (price === null) return null;
  try {
    return priceToTicks(requireInstrument(symbol), price);
  } catch {
    return null;
  }
}

/** Apply live marks to a stored projection row. */
export function valueProjection(row: AccountProjectionRow, market: ProjectionMarket): ValuedProjection {
  const stored = (row.positions as ProjectionPosition[]) ?? [];
  let unrealized: number | null = 0;
  for (const p of stored) {
    if (unrealized === null) break;
    let spec;
    try {
      spec = requireInstrument(p.symbol);
    } catch {
      unrealized = null;
      break;
    }
    const markTicks = markTicksFor(p.symbol, p.marketEra, p.contractCode, market);
    if (markTicks === null) {
      unrealized = null;
      break;
    }
    const state: PositionState = {
      symbol: p.symbol,
      qty: p.qty,
      costBasisMicros: p.costBasisMicros,
      realizedPnlMicros: 0,
      feesMicros: 0,
      openedAt: null,
      updatedAt: null,
    };
    unrealized += unrealizedPnlMicros(spec, state, markTicks);
  }

  const equity = unrealized === null ? null : row.balanceMicros + unrealized;
  const remaining = equity === null ? null : equity - row.drawdownFloorMicros;

  return {
    accountId: row.accountId,
    userId: row.userId,
    organizationId: row.organizationId,
    stateVersion: row.stateVersion,
    status: row.status,
    adminHold: row.adminHold,
    ruleStatus: row.ruleStatus,
    startingBalanceMicros: row.startingBalanceMicros,
    balanceMicros: row.balanceMicros,
    realizedPnlMicros: row.realizedPnlMicros,
    feesMicros: row.feesMicros,
    openContracts: row.openContracts,
    workingOrderCount: row.workingOrderCount,
    unrealizedPnlMicros: unrealized,
    equityMicros: equity,
    remainingLossMicros: remaining,
    drawdownFloorMicros: row.drawdownFloorMicros,
    highWaterMarkMicros: row.highWaterMarkMicros,
    lastFinancialMutationAt: row.lastFinancialMutationAt?.getTime() ?? null,
    projectionUpdatedAt: row.projectionUpdatedAt.getTime(),
    consistent: row.consistent,
  };
}

/** A presented open position, valued from the projection at read time. */
export interface ValuedPosition {
  readonly symbol: string;
  readonly side: string;
  readonly qty: number;
  readonly avgEntryPrice: number | null;
  readonly markPrice: number | null;
  readonly unrealizedPnlMicros: number | null;
  readonly openedAt: number | null;
}

/**
 * Present each open position in a projection, valued from current marks. Pure
 * computation on the stored row - no engine, no database, no template load - so
 * a firm-wide surveillance read costs a projection scan, not N reconstructions.
 */
export function valuePositions(row: AccountProjectionRow, market: ProjectionMarket): ValuedPosition[] {
  const stored = (row.positions as ProjectionPosition[]) ?? [];
  return stored
    .filter((p) => Math.abs(p.qty) > 0)
    .map((p) => {
      let spec;
      try {
        spec = requireInstrument(p.symbol);
      } catch {
        return {
          symbol: p.symbol,
          side: p.side,
          qty: Math.abs(p.qty),
          avgEntryPrice: null,
          markPrice: null,
          unrealizedPnlMicros: null,
          openedAt: p.openedAt,
        };
      }
      const state: PositionState = {
        symbol: p.symbol,
        qty: p.qty,
        costBasisMicros: p.costBasisMicros,
        realizedPnlMicros: 0,
        feesMicros: 0,
        openedAt: null,
        updatedAt: null,
      };
      const avgTicks = avgEntryTicks(spec, state);
      const markTicks = markTicksFor(p.symbol, p.marketEra, p.contractCode, market);
      return {
        symbol: p.symbol,
        side: p.side,
        qty: Math.abs(p.qty),
        avgEntryPrice: ticksToPrice(spec, avgTicks),
        markPrice: markTicks === null ? null : ticksToPrice(spec, markTicks),
        unrealizedPnlMicros: markTicks === null ? null : unrealizedPnlMicros(spec, state, markTicks),
        openedAt: p.openedAt,
      };
    });
}

export interface ProjectionWithIdentity {
  readonly projection: AccountProjectionRow;
  readonly publicId: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Projections for one organisation's accounts that currently hold open exposure,
 * with the trader identity, for owner surveillance/risk. Scoped by the account's
 * organization (matching the existing routes), and bounded by `limit`. This is a
 * projection scan plus a join - no per-account reconstruction.
 */
export async function listOpenProjections(
  db: Database,
  organizationId: string,
  limit = 300,
): Promise<ProjectionWithIdentity[]> {
  const rows = await db
    .select({
      projection: accountProjections,
      publicId: accounts.publicId,
      name: accounts.name,
      email: users.email,
    })
    .from(accountProjections)
    .innerJoin(accounts, eq(accountProjections.accountId, accounts.id))
    .innerJoin(users, eq(accounts.userId, users.id))
    .where(and(eq(accounts.organizationId, organizationId), sql`${accountProjections.openContracts} > 0`))
    .limit(limit);
  return rows.map((r) => ({ projection: r.projection, publicId: r.publicId, name: r.name, email: r.email }));
}

/** Read one account's valued projection, or null if not projected yet. */
export async function readAccountProjection(
  db: Database,
  market: ProjectionMarket,
  accountId: string,
): Promise<ValuedProjection | null> {
  const [row] = await db
    .select()
    .from(accountProjections)
    .where(eq(accountProjections.accountId, accountId));
  return row ? valueProjection(row, market) : null;
}

/** The outbox handler: an account changed, so re-snapshot it from authority. */
export async function accountOutboxHandler(
  tx: Database,
  event: { aggregateType: string; aggregateId: string },
): Promise<void> {
  if (event.aggregateType !== 'ACCOUNT') return;
  await projectAccount(tx, event.aggregateId);
}

export interface ReconcileDiff {
  readonly field: string;
  readonly projected: unknown;
  readonly authoritative: unknown;
}

export interface ReconcileResult {
  readonly accountId: string;
  readonly ok: boolean;
  /** True when no projection row exists for an account that should have one. */
  readonly missing: boolean;
  readonly diffs: ReconcileDiff[];
}

/**
 * Compare the stored projection against a fresh authoritative snapshot, without
 * writing anything. Market-dependent fields (equity, unrealized) are NOT
 * compared here - those are read-time valuations, not stored truth. This checks
 * only what the projection is supposed to hold authoritatively.
 */
export async function reconcileAccountProjection(
  db: Database,
  accountId: string,
): Promise<ReconcileResult> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  const [projection] = await db
    .select()
    .from(accountProjections)
    .where(eq(accountProjections.accountId, accountId));

  if (!account) {
    // No account: a lingering projection is drift.
    return {
      accountId,
      ok: !projection,
      missing: false,
      diffs: projection ? [{ field: 'account', projected: 'exists', authoritative: 'deleted' }] : [],
    };
  }
  if (!projection) {
    return { accountId, ok: false, missing: true, diffs: [] };
  }

  const openPositions = await db
    .select()
    .from(positions)
    .where(and(eq(positions.accountId, accountId), sql`${positions.qty} <> 0`));
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.accountId, accountId), inArray(orders.status, OPEN_ORDER_STATUSES)));
  const openContracts = openPositions.reduce((s, p) => s + Math.abs(p.qty), 0);

  const diffs: ReconcileDiff[] = [];
  const check = (field: string, projected: unknown, authoritative: unknown): void => {
    if (projected !== authoritative) diffs.push({ field, projected, authoritative });
  };
  check('stateVersion', projection.stateVersion, account.seq);
  check('balanceMicros', projection.balanceMicros, account.balanceMicros);
  check('realizedPnlMicros', projection.realizedPnlMicros, account.realizedPnlMicros);
  check('feesMicros', projection.feesMicros, account.feesMicros);
  check('highWaterMarkMicros', projection.highWaterMarkMicros, account.highWaterMarkMicros);
  check('drawdownFloorMicros', projection.drawdownFloorMicros, account.drawdownFloorMicros);
  check('status', projection.status, account.status);
  check('adminHold', projection.adminHold, account.adminHold ?? null);
  check('ruleStatus', projection.ruleStatus, account.ruleStatus);
  check('openContracts', projection.openContracts, openContracts);
  check('workingOrderCount', projection.workingOrderCount, countRows[0]?.n ?? 0);

  return { accountId, ok: diffs.length === 0, missing: false, diffs };
}

/** Reconcile every account. Returns the accounts that drifted (with their diffs). */
export async function reconcileAll(
  db: Database,
  opts: { organizationId?: string } = {},
): Promise<{ checked: number; drifted: ReconcileResult[] }> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(opts.organizationId ? eq(accounts.organizationId, opts.organizationId) : undefined);
  const drifted: ReconcileResult[] = [];
  for (const { id } of rows) {
    const r = await reconcileAccountProjection(db, id);
    if (!r.ok) drifted.push(r);
  }
  return { checked: rows.length, drifted };
}

/**
 * Rebuild projections from authoritative state. Never mutates financial truth -
 * no fills, no balances, no lifecycle, no audit. Safe after projection loss or
 * corruption. Returns the number rebuilt.
 */
export async function rebuildAllProjections(
  db: Database,
  opts: { organizationId?: string; batch?: number } = {},
): Promise<number> {
  const batch = opts.batch ?? 500;
  let done = 0;
  let cursor: string | null = null;
  for (;;) {
    const where = [] as unknown[];
    if (opts.organizationId) where.push(eq(accounts.organizationId, opts.organizationId));
    if (cursor) where.push(sql`${accounts.id} > ${cursor}`);
    const page = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(where.length ? (and(...(where as never[])) as never) : undefined)
      .orderBy(accounts.id)
      .limit(batch);
    if (page.length === 0) break;
    for (const { id } of page) {
      await projectAccount(db, id);
      done += 1;
    }
    cursor = page[page.length - 1]!.id;
    if (page.length < batch) break;
  }
  return done;
}
