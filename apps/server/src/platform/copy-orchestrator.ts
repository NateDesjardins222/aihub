/**
 * Copy orchestrator — turns ONE leader action into ONE copy intent and MANY
 * independent account executions through the EXISTING execution/risk pipeline
 * (docs/copy-trading-v1.md §8, copy-execution-semantics-v1.md). It never fills an
 * order, never computes money, never bypasses risk: each child calls
 * `execution.submitOrder` (leader included), which runs that account's full
 * risk + execution pipeline under its own lock. A child rejection is recorded on
 * that child alone; valid children are never rolled back.
 *
 * Exactly-once: the intent's group-scoped idempotency key collapses retries to
 * one intent; each child's deterministic clientOrderId collapses to one order
 * per account (the engine's own unique index is the second backstop).
 */
import { and, eq, ne } from 'drizzle-orm';
import { getInstrument } from '@atlas/instruments';
import type { Database } from '../db/client.js';
import { accounts, copyChildren, copyFollowers, copyGroups, copyIntents, orders, positions } from '../db/schema.js';
import type { ExecutionProvider } from '../execution/provider.js';
import { OrderRejectedError } from '../trading/engine.js';
import { offsetToTicks, toTicks, type LevelOffset } from '../trading/order-levels.js';
import { computeFollowerQty, type SizingMode } from './copy-sizing.js';
import { accountTradeCapable, CopyGroupError, ownedGroup, pauseGroup } from './copy-groups.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';

export interface CopyOrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT' | 'TRAILING_STOP';
  limitPrice?: number | null;
  stopPrice?: number | null;
  tif?: 'DAY' | 'GTC' | 'IOC' | 'FOK';
  trailTicks?: number | null;
  bracket?: {
    stopLoss?: LevelOffset | null;
    takeProfit?: LevelOffset | null;
    trailingStop?: LevelOffset | null;
  } | null;
}

export type CopyChildStatus = 'ACCEPTED' | 'REJECTED' | 'SKIPPED' | 'PENDING';

export interface CopyChildResult {
  accountId: string;
  publicId: string;
  role: 'LEADER' | 'FOLLOWER';
  status: CopyChildStatus;
  requestedQty: number;
  sizingNote: string | null;
  orderId: string | null;
  rejectCode: string | null;
  rejectMessage: string | null;
}

export interface CopyIntentResult {
  intentId: string;
  kind: string;
  reused: boolean;
  accepted: number;
  rejected: number;
  skipped: number;
  total: number;
  children: CopyChildResult[];
}

interface Target {
  accountId: string;
  publicId: string;
  role: 'LEADER' | 'FOLLOWER';
  qty: number;
  note: string;
  skipped: boolean;
}

/** A short, deterministic, per-(intent,account) client order id (≤128 chars). */
function childClientOrderId(intentId: string, accountId: string): string {
  return `cpy-${intentId}-${accountId}`;
}

export interface SubmitCopyIntentInput {
  userId: string;
  groupId: string;
  idempotencyKey: string;
  order: CopyOrderRequest;
}

export async function submitCopyIntent(
  db: Database,
  execution: ExecutionProvider,
  input: SubmitCopyIntentInput,
): Promise<CopyIntentResult> {
  const group = await ownedGroup(db, input.userId, input.groupId);
  if (group.status !== 'ACTIVE') {
    throw new CopyGroupError('INVALID_STATE', group.status === 'PAUSED' ? 'The copy group is paused.' : 'The copy group is disabled.');
  }
  if (!group.leaderAccountId) throw new CopyGroupError('INVALID_STATE', 'The group has no leader.');

  const spec = getInstrument(input.order.symbol);
  if (!spec) throw new CopyGroupError('INVALID_STATE', `Unknown instrument ${input.order.symbol}.`);

  // Leader eligibility at execution time. A lost leader pauses the group.
  const [leaderAcct] = await db.select().from(accounts).where(eq(accounts.id, group.leaderAccountId));
  if (!leaderAcct) throw new CopyGroupError('ACCOUNT_NOT_FOUND', 'Leader account gone.');
  const leaderElig = accountTradeCapable(leaderAcct);
  if (!leaderElig.eligible) {
    await pauseGroup(db, input.userId, input.groupId, `Leader ineligible: ${leaderElig.reason}`).catch(() => undefined);
    throw new CopyGroupError('INELIGIBLE_ACCOUNT', `The leader account is no longer eligible to trade (${leaderElig.reason}). The group has been paused.`);
  }

  // Record the intent exactly once (group-scoped idempotency key).
  const [intentRow] = await db
    .insert(copyIntents)
    .values({
      copyGroupId: input.groupId,
      leaderAccountId: group.leaderAccountId,
      kind: 'SUBMIT',
      idempotencyKey: input.idempotencyKey,
      symbol: spec.root,
      side: input.order.side,
      qty: input.order.qty,
      orderType: input.order.type,
      limitTicks: toTicks(spec, input.order.limitPrice),
      stopTicks: toTicks(spec, input.order.stopPrice),
      bracketConfig: (input.order.bracket ?? null) as object | null,
      state: 'PENDING',
    })
    .onConflictDoNothing({ target: [copyIntents.copyGroupId, copyIntents.idempotencyKey] })
    .returning();

  if (!intentRow) {
    // Idempotent replay: an intent with this key already exists. Return its
    // children as they stand — no second execution, no duplicate orders.
    const [existing] = await db
      .select()
      .from(copyIntents)
      .where(and(eq(copyIntents.copyGroupId, input.groupId), eq(copyIntents.idempotencyKey, input.idempotencyKey)));
    return summarizeExisting(db, existing!);
  }
  const intentId = intentRow.id;

  // Build the targets: leader + enabled followers, with per-account sizing.
  const followerRows = await db
    .select({ f: copyFollowers, a: accounts })
    .from(copyFollowers)
    .innerJoin(accounts, eq(copyFollowers.accountId, accounts.id))
    .where(and(eq(copyFollowers.copyGroupId, input.groupId), eq(copyFollowers.enabled, true)));

  const targets: Target[] = [
    { accountId: leaderAcct.id, publicId: leaderAcct.publicId, role: 'LEADER', qty: input.order.qty, note: `SAME size = ${input.order.qty}`, skipped: false },
  ];
  for (const { f, a } of followerRows) {
    const sized = computeFollowerQty(input.order.qty, {
      mode: group.sizingMode as SizingMode,
      multiplierMilli: f.sizingMultiplierMilli,
      fixedQty: f.sizingFixedQty,
    });
    targets.push({ accountId: a.id, publicId: a.publicId, role: 'FOLLOWER', qty: sized.qty, note: sized.note, skipped: sized.skipped });
  }

  // Persist children PENDING (one per account, unique per (intent, account)).
  for (const t of targets) {
    await db
      .insert(copyChildren)
      .values({
        copyIntentId: intentId,
        accountId: t.accountId,
        role: t.role,
        requestedQty: t.qty,
        sizingNote: t.note.slice(0, 200),
        status: t.skipped ? 'SKIPPED' : 'PENDING',
      })
      .onConflictDoNothing({ target: [copyChildren.copyIntentId, copyChildren.accountId] });
  }
  await db.update(copyIntents).set({ state: 'FANNED_OUT', updatedAt: new Date() }).where(eq(copyIntents.id, intentId));

  // Fan out in parallel. Each child runs the full existing pipeline for its
  // account; a rejection is recorded on that child only.
  const results = await Promise.all(
    targets.map((t) => executeChild(db, execution, input, spec, intentId, t)),
  );

  await db.update(copyIntents).set({ state: 'COMPLETE', leaderOrderId: results.find((r) => r.role === 'LEADER')?.orderId ?? null, updatedAt: new Date() }).where(eq(copyIntents.id, intentId));

  await recordAudit(db, {
    organizationId: group.organizationId,
    actor: { type: 'USER', userId: input.userId },
    subjectType: 'ACCOUNT',
    subjectId: group.leaderAccountId,
    accountId: group.leaderAccountId,
    userId: input.userId,
    action: 'copy.intent.created',
    newState: {
      intentId, groupId: input.groupId, symbol: spec.root, side: input.order.side, qty: input.order.qty,
      children: results.map((r) => ({ accountId: r.accountId, status: r.status, qty: r.requestedQty, reject: r.rejectCode })),
    },
    reason: null,
  });
  await events.publish(db, {
    type: 'copy.intent.created',
    organizationId: group.organizationId,
    userId: input.userId,
    accountId: group.leaderAccountId,
    payload: { intentId, groupId: input.groupId },
  });

  return summarize(intentId, 'SUBMIT', false, results);
}

async function executeChild(
  db: Database,
  execution: ExecutionProvider,
  input: SubmitCopyIntentInput,
  spec: NonNullable<ReturnType<typeof getInstrument>>,
  intentId: string,
  t: Target,
): Promise<CopyChildResult> {
  const base: CopyChildResult = {
    accountId: t.accountId, publicId: t.publicId, role: t.role, status: 'PENDING',
    requestedQty: t.qty, sizingNote: t.note, orderId: null, rejectCode: null, rejectMessage: null,
  };
  if (t.skipped || t.qty <= 0) {
    await setChild(db, intentId, t.accountId, { status: 'SKIPPED' });
    return { ...base, status: 'SKIPPED' };
  }
  const clientOrderId = childClientOrderId(intentId, t.accountId);
  try {
    await execution.submitOrder({
      accountId: t.accountId,
      userId: input.userId,
      clientOrderId,
      symbol: spec.root,
      side: input.order.side,
      qty: t.qty,
      type: input.order.type,
      limitTicks: toTicks(spec, input.order.limitPrice),
      stopTicks: toTicks(spec, input.order.stopPrice),
      tif: input.order.tif,
      trailTicks: input.order.trailTicks ?? null,
      // Bracket OFFSETS recomputed for THIS account's qty (preserves the
      // intended distance; each account's legs are built from its own fill).
      bracket: input.order.bracket
        ? {
            stopLossTicks: offsetToTicks(spec, input.order.bracket.stopLoss, t.qty),
            takeProfitTicks: offsetToTicks(spec, input.order.bracket.takeProfit, t.qty),
            trailingStopTicks: offsetToTicks(spec, input.order.bracket.trailingStop, t.qty),
          }
        : null,
    });
    // Resolve the authoritative order id for correlation (modify/cancel).
    const [row] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.accountId, t.accountId), eq(orders.clientOrderId, clientOrderId)));
    const orderId = row?.id ?? null;
    await setChild(db, intentId, t.accountId, { status: 'ACCEPTED', orderId });
    await events.publish(db, { type: 'copy.child.accepted', organizationId: null, userId: input.userId, accountId: t.accountId, payload: { intentId, orderId } }).catch(() => undefined);
    return { ...base, status: 'ACCEPTED', orderId };
  } catch (err) {
    const code = err instanceof OrderRejectedError ? err.reason : 'INTERNAL_ERROR';
    const message = err instanceof OrderRejectedError ? err.message : 'Order could not be placed.';
    await setChild(db, intentId, t.accountId, { status: 'REJECTED', rejectCode: code, rejectMessage: message });
    await events.publish(db, { type: 'copy.child.rejected', organizationId: null, userId: input.userId, accountId: t.accountId, payload: { intentId, code } }).catch(() => undefined);
    return { ...base, status: 'REJECTED', rejectCode: code, rejectMessage: message };
  }
}

async function setChild(
  db: Database,
  intentId: string,
  accountId: string,
  patch: { status: CopyChildStatus; orderId?: string | null; rejectCode?: string; rejectMessage?: string },
): Promise<void> {
  await db
    .update(copyChildren)
    .set({
      status: patch.status,
      orderId: patch.orderId ?? null,
      rejectCode: patch.rejectCode ?? null,
      rejectMessage: patch.rejectMessage?.slice(0, 2000) ?? null,
      updatedAt: new Date(),
    } as never)
    .where(and(eq(copyChildren.copyIntentId, intentId), eq(copyChildren.accountId, accountId)));
}

function summarize(intentId: string, kind: string, reused: boolean, results: CopyChildResult[]): CopyIntentResult {
  return {
    intentId, kind, reused,
    accepted: results.filter((r) => r.status === 'ACCEPTED').length,
    rejected: results.filter((r) => r.status === 'REJECTED').length,
    skipped: results.filter((r) => r.status === 'SKIPPED').length,
    total: results.length,
    children: results,
  };
}

async function summarizeExisting(db: Database, intent: typeof copyIntents.$inferSelect): Promise<CopyIntentResult> {
  const rows = await db
    .select({ c: copyChildren, a: accounts })
    .from(copyChildren)
    .innerJoin(accounts, eq(copyChildren.accountId, accounts.id))
    .where(eq(copyChildren.copyIntentId, intent.id));
  const children: CopyChildResult[] = rows.map(({ c, a }) => ({
    accountId: c.accountId, publicId: a.publicId, role: c.role as 'LEADER' | 'FOLLOWER',
    status: c.status as CopyChildStatus, requestedQty: c.requestedQty, sizingNote: c.sizingNote ?? null,
    orderId: c.orderId ?? null, rejectCode: c.rejectCode ?? null, rejectMessage: c.rejectMessage ?? null,
  }));
  return summarize(intent.id, intent.kind, true, children);
}

/** Recent intents for a group (UI + audit + reconciliation). */
export async function listIntents(db: Database, userId: string, groupId: string, limit = 25): Promise<CopyIntentResult[]> {
  await ownedGroup(db, userId, groupId);
  const intents = await db
    .select()
    .from(copyIntents)
    .where(eq(copyIntents.copyGroupId, groupId))
    .orderBy(copyIntents.createdAt)
    .limit(limit);
  const out: CopyIntentResult[] = [];
  for (const i of intents) out.push(await summarizeExisting(db, i));
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Modify / cancel / flatten — propagate a leader working-order action to the
// followers' corresponding child orders (docs/copy-execution-semantics-v1.md
// §6, §7, §10). Each is per-account, independently validated, idempotent, and
// records a new intent + children so the outcome is auditable and divergence is
// visible. A per-follower failure is recorded on that child, never a false
// "synced".
// ---------------------------------------------------------------------------

/** The ACCEPTED children of a prior intent that still carry an order id. */
async function childrenWithOrders(db: Database, intentId: string) {
  return db
    .select({ c: copyChildren, a: accounts, o: orders })
    .from(copyChildren)
    .innerJoin(accounts, eq(copyChildren.accountId, accounts.id))
    .innerJoin(orders, eq(copyChildren.orderId, orders.id))
    .where(and(eq(copyChildren.copyIntentId, intentId), eq(copyChildren.status, 'ACCEPTED')));
}

async function recordActionIntent(
  db: Database,
  group: typeof copyGroups.$inferSelect,
  kind: 'MODIFY' | 'CANCEL' | 'FLATTEN',
  idempotencyKey: string,
  leaderOrderId: string | null,
): Promise<{ intentId: string; reused: boolean }> {
  const [row] = await db
    .insert(copyIntents)
    .values({ copyGroupId: group.id, leaderAccountId: group.leaderAccountId!, kind, idempotencyKey, leaderOrderId, state: 'FANNED_OUT' })
    .onConflictDoNothing({ target: [copyIntents.copyGroupId, copyIntents.idempotencyKey] })
    .returning();
  if (row) return { intentId: row.id, reused: false };
  const [existing] = await db.select().from(copyIntents).where(and(eq(copyIntents.copyGroupId, group.id), eq(copyIntents.idempotencyKey, idempotencyKey)));
  return { intentId: existing!.id, reused: true };
}

export interface ModifyCopyInput {
  userId: string;
  groupId: string;
  /** The prior SUBMIT intent whose working orders are being modified. */
  originalIntentId: string;
  idempotencyKey: string;
  patch: { qty?: number; limitPrice?: number | null; stopPrice?: number | null; trailTicks?: number | null };
}

export async function modifyCopyIntent(db: Database, execution: ExecutionProvider, input: ModifyCopyInput): Promise<CopyIntentResult> {
  const group = await ownedGroup(db, input.userId, input.groupId);
  if (group.status === 'DISABLED') throw new CopyGroupError('INVALID_STATE', 'The copy group is disabled.');
  const rec = await recordActionIntent(db, group, 'MODIFY', input.idempotencyKey, null);
  if (rec.reused) {
    const [existing] = await db.select().from(copyIntents).where(eq(copyIntents.id, rec.intentId));
    return summarizeExisting(db, existing!);
  }
  const kids = await childrenWithOrders(db, input.originalIntentId);
  const results = await Promise.all(
    kids.map(async ({ a, o }) => {
      const spec = getInstrument(o.symbol);
      const patch: { qty?: number; limitTicks?: number | null; stopTicks?: number | null; trailTicks?: number | null } = {};
      if (input.patch.qty !== undefined) patch.qty = input.patch.qty;
      if (input.patch.limitPrice !== undefined && spec) patch.limitTicks = toTicks(spec, input.patch.limitPrice);
      if (input.patch.stopPrice !== undefined && spec) patch.stopTicks = toTicks(spec, input.patch.stopPrice);
      if (input.patch.trailTicks !== undefined) patch.trailTicks = input.patch.trailTicks;
      return applyChildAction(db, rec.intentId, a, o.id, () => execution.modifyOrder(a.id, o.id, patch));
    }),
  );
  await db.update(copyIntents).set({ state: 'COMPLETE', updatedAt: new Date() }).where(eq(copyIntents.id, rec.intentId));
  return summarize(rec.intentId, 'MODIFY', false, results);
}

export interface CancelCopyInput {
  userId: string;
  groupId: string;
  originalIntentId: string;
  idempotencyKey: string;
}

export async function cancelCopyIntent(db: Database, execution: ExecutionProvider, input: CancelCopyInput): Promise<CopyIntentResult> {
  const group = await ownedGroup(db, input.userId, input.groupId);
  if (group.status === 'DISABLED') throw new CopyGroupError('INVALID_STATE', 'The copy group is disabled.');
  const rec = await recordActionIntent(db, group, 'CANCEL', input.idempotencyKey, null);
  if (rec.reused) {
    const [existing] = await db.select().from(copyIntents).where(eq(copyIntents.id, rec.intentId));
    return summarizeExisting(db, existing!);
  }
  const kids = await childrenWithOrders(db, input.originalIntentId);
  const results = await Promise.all(
    kids.map(({ a, o }) => applyChildAction(db, rec.intentId, a, o.id, () => execution.cancelOrder(a.id, o.id))),
  );
  await db.update(copyIntents).set({ state: 'COMPLETE', updatedAt: new Date() }).where(eq(copyIntents.id, rec.intentId));
  return summarize(rec.intentId, 'CANCEL', false, results);
}

export interface FlattenCopyInput {
  userId: string;
  groupId: string;
  idempotencyKey: string;
  /** Restrict to one instrument; omitted flattens every open position per account. */
  symbol?: string | null;
}

/**
 * Flatten the leader and every ENABLED follower independently (cancel working
 * orders, market-close the position) via engine.flatten per account, in
 * parallel. Partial failures are visible; idempotent (flattening flat = no-op).
 */
export async function flattenCopyGroup(db: Database, execution: ExecutionProvider, input: FlattenCopyInput): Promise<CopyIntentResult> {
  const group = await ownedGroup(db, input.userId, input.groupId);
  if (group.status === 'DISABLED') throw new CopyGroupError('INVALID_STATE', 'The copy group is disabled.');
  if (!group.leaderAccountId) throw new CopyGroupError('INVALID_STATE', 'The group has no leader.');
  const rec = await recordActionIntent(db, group, 'FLATTEN', input.idempotencyKey, null);
  if (rec.reused) {
    const [existing] = await db.select().from(copyIntents).where(eq(copyIntents.id, rec.intentId));
    return summarizeExisting(db, existing!);
  }

  const followerRows = await db
    .select({ a: accounts })
    .from(copyFollowers)
    .innerJoin(accounts, eq(copyFollowers.accountId, accounts.id))
    .where(and(eq(copyFollowers.copyGroupId, input.groupId), eq(copyFollowers.enabled, true)));
  const [leaderAcct] = await db.select().from(accounts).where(eq(accounts.id, group.leaderAccountId));
  const memberAccounts = [leaderAcct!, ...followerRows.map((r) => r.a)];

  const results = await Promise.all(
    memberAccounts.map(async (a) => {
      const role: 'LEADER' | 'FOLLOWER' = a.id === group.leaderAccountId ? 'LEADER' : 'FOLLOWER';
      // Which symbols to flatten for this account.
      const symbols = input.symbol
        ? [input.symbol]
        : (await db.select({ symbol: positions.symbol }).from(positions).where(and(eq(positions.accountId, a.id), ne(positions.qty, 0)))).map((p) => p.symbol);
      // Write a child row for the account (order id is not meaningful for flatten).
      await db
        .insert(copyChildren)
        .values({ copyIntentId: rec.intentId, accountId: a.id, role, requestedQty: 0, sizingNote: symbols.length === 0 ? 'already flat' : `flatten ${symbols.join(',')}`, status: 'PENDING' })
        .onConflictDoNothing({ target: [copyChildren.copyIntentId, copyChildren.accountId] });
      if (symbols.length === 0) {
        await setChild(db, rec.intentId, a.id, { status: 'ACCEPTED' });
        return { accountId: a.id, publicId: a.publicId, role, status: 'ACCEPTED' as CopyChildStatus, requestedQty: 0, sizingNote: 'already flat', orderId: null, rejectCode: null, rejectMessage: null };
      }
      try {
        for (const s of symbols) await execution.flatten(a.id, input.userId, s);
        await setChild(db, rec.intentId, a.id, { status: 'ACCEPTED' });
        return { accountId: a.id, publicId: a.publicId, role, status: 'ACCEPTED' as CopyChildStatus, requestedQty: 0, sizingNote: `flattened ${symbols.join(',')}`, orderId: null, rejectCode: null, rejectMessage: null };
      } catch (err) {
        const code = err instanceof OrderRejectedError ? err.reason : 'INTERNAL_ERROR';
        const message = err instanceof OrderRejectedError ? err.message : 'Flatten failed.';
        await setChild(db, rec.intentId, a.id, { status: 'REJECTED', rejectCode: code, rejectMessage: message });
        return { accountId: a.id, publicId: a.publicId, role, status: 'REJECTED' as CopyChildStatus, requestedQty: 0, sizingNote: null, orderId: null, rejectCode: code, rejectMessage: message };
      }
    }),
  );
  await db.update(copyIntents).set({ state: 'COMPLETE', updatedAt: new Date() }).where(eq(copyIntents.id, rec.intentId));
  await events.publish(db, { type: 'copy.group.flattened', organizationId: group.organizationId, userId: input.userId, accountId: group.leaderAccountId, payload: { intentId: rec.intentId } }).catch(() => undefined);
  return summarize(rec.intentId, 'FLATTEN', false, results);
}

/** Run one per-account modify/cancel, recording the child outcome. */
async function applyChildAction(
  db: Database,
  intentId: string,
  account: typeof accounts.$inferSelect,
  orderId: string,
  action: () => Promise<unknown>,
): Promise<CopyChildResult> {
  const role: 'LEADER' | 'FOLLOWER' = 'FOLLOWER';
  await db
    .insert(copyChildren)
    .values({ copyIntentId: intentId, accountId: account.id, role, requestedQty: 0, status: 'PENDING', orderId })
    .onConflictDoNothing({ target: [copyChildren.copyIntentId, copyChildren.accountId] });
  try {
    await action();
    await setChild(db, intentId, account.id, { status: 'ACCEPTED', orderId });
    return { accountId: account.id, publicId: account.publicId, role, status: 'ACCEPTED', requestedQty: 0, sizingNote: null, orderId, rejectCode: null, rejectMessage: null };
  } catch (err) {
    const code = err instanceof OrderRejectedError ? err.reason : 'INTERNAL_ERROR';
    const message = err instanceof OrderRejectedError ? err.message : 'Action failed.';
    await setChild(db, intentId, account.id, { status: 'REJECTED', orderId, rejectCode: code, rejectMessage: message });
    return { accountId: account.id, publicId: account.publicId, role, status: 'REJECTED', requestedQty: 0, sizingNote: null, orderId, rejectCode: code, rejectMessage: message };
  }
}

/**
 * A single-account resync order: places one market order at a follower to close
 * a divergence gap, recorded as a RESYNC intent with one child, through the
 * normal risk pipeline (it may be rejected). Never re-trades the leader.
 */
export async function submitResyncOrder(
  db: Database,
  execution: ExecutionProvider,
  input: { userId: string; groupId: string; accountId: string; idempotencyKey: string; symbol: string; side: 'BUY' | 'SELL'; qty: number },
): Promise<CopyIntentResult> {
  const group = await ownedGroup(db, input.userId, input.groupId);
  const spec = getInstrument(input.symbol);
  if (!spec) throw new CopyGroupError('INVALID_STATE', `Unknown instrument ${input.symbol}.`);
  const [row] = await db
    .insert(copyIntents)
    .values({ copyGroupId: input.groupId, leaderAccountId: group.leaderAccountId!, kind: 'RESYNC', idempotencyKey: input.idempotencyKey, symbol: spec.root, side: input.side, qty: input.qty, orderType: 'MARKET', state: 'FANNED_OUT' })
    .onConflictDoNothing({ target: [copyIntents.copyGroupId, copyIntents.idempotencyKey] })
    .returning();
  if (!row) {
    const [existing] = await db.select().from(copyIntents).where(and(eq(copyIntents.copyGroupId, input.groupId), eq(copyIntents.idempotencyKey, input.idempotencyKey)));
    return summarizeExisting(db, existing!);
  }
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, input.accountId));
  await db.insert(copyChildren).values({ copyIntentId: row.id, accountId: input.accountId, role: 'FOLLOWER', requestedQty: input.qty, sizingNote: `resync ${input.side} ${input.qty}`, status: 'PENDING' }).onConflictDoNothing({ target: [copyChildren.copyIntentId, copyChildren.accountId] });
  const result = await executeChild(db, execution, { userId: input.userId, groupId: input.groupId, idempotencyKey: input.idempotencyKey, order: { symbol: spec.root, side: input.side, qty: input.qty, type: 'MARKET' } }, spec, row.id, { accountId: input.accountId, publicId: acct?.publicId ?? '', role: 'FOLLOWER', qty: input.qty, note: `resync ${input.side} ${input.qty}`, skipped: false });
  await db.update(copyIntents).set({ state: 'COMPLETE', updatedAt: new Date() }).where(eq(copyIntents.id, row.id));
  return summarize(row.id, 'RESYNC', false, [result]);
}
