/**
 * Copy divergence & resync (docs/copy-execution-semantics-v1.md §12–13).
 *
 * Group sync is DERIVED, never stored as truth: each enabled follower's actual
 * net position is compared to its sizing-adjusted expected position (from the
 * leader's position), per instrument the group holds. A mismatch is DIVERGED
 * with a per-account reason; resync proposes the exact market order to close the
 * gap and executes it — only on explicit request — through the normal risk
 * pipeline (a resync order can itself be rejected). Divergence is never hidden
 * and resync is never silent.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, copyFollowers, positions } from '../db/schema.js';
import type { ExecutionProvider } from '../execution/provider.js';
import { computeFollowerQty, type SizingMode } from './copy-sizing.js';
import { ownedGroup, CopyGroupError } from './copy-groups.js';
import { submitCopyIntent, type CopyIntentResult } from './copy-orchestrator.js';
import { events } from './events.js';

export type GroupSyncStatus = 'SYNCED' | 'DIVERGED' | 'PAUSED' | 'DISABLED';

export interface FollowerDelta {
  accountId: string;
  publicId: string;
  symbol: string;
  expectedQty: number; // signed (sizing-adjusted leader net)
  actualQty: number; // signed
  deltaQty: number; // expected - actual; the resync amount (signed)
  side: 'BUY' | 'SELL' | null; // side of the resync order, if any
  inSync: boolean;
}

export interface GroupSyncView {
  groupId: string;
  status: GroupSyncStatus;
  followers: FollowerDelta[];
  divergedAccountIds: string[];
}

type Pos = { accountId: string; symbol: string; qty: number };

async function positionsFor(db: Database, accountIds: string[]): Promise<Map<string, Pos[]>> {
  const map = new Map<string, Pos[]>();
  if (accountIds.length === 0) return map;
  const rows = await db
    .select({ accountId: positions.accountId, symbol: positions.symbol, qty: positions.qty })
    .from(positions)
    .where(and(ne(positions.qty, 0)));
  for (const r of rows) {
    if (!accountIds.includes(r.accountId)) continue;
    const list = map.get(r.accountId) ?? [];
    list.push(r);
    map.set(r.accountId, list);
  }
  return map;
}

/** Derive the group's sync view: per-follower expected vs actual, with deltas. */
export async function groupSyncView(db: Database, userId: string, groupId: string): Promise<GroupSyncView> {
  const group = await ownedGroup(db, userId, groupId);
  if (group.status === 'DISABLED') return { groupId, status: 'DISABLED', followers: [], divergedAccountIds: [] };
  if (!group.leaderAccountId) return { groupId, status: group.status === 'PAUSED' ? 'PAUSED' : 'DIVERGED', followers: [], divergedAccountIds: [] };

  const followerRows = await db
    .select({ f: copyFollowers, a: accounts })
    .from(copyFollowers)
    .innerJoin(accounts, eq(copyFollowers.accountId, accounts.id))
    .where(and(eq(copyFollowers.copyGroupId, groupId), eq(copyFollowers.enabled, true)));

  const allIds = [group.leaderAccountId, ...followerRows.map((r) => r.a.id)];
  const posMap = await positionsFor(db, allIds);
  const leaderPositions = posMap.get(group.leaderAccountId) ?? [];

  // Every symbol the leader or any follower currently holds.
  const symbols = new Set<string>();
  for (const list of posMap.values()) for (const p of list) symbols.add(p.symbol);

  const deltas: FollowerDelta[] = [];
  const diverged = new Set<string>();
  for (const { f, a } of followerRows) {
    const actualBySym = new Map((posMap.get(a.id) ?? []).map((p) => [p.symbol, p.qty]));
    for (const symbol of symbols) {
      const leaderQty = leaderPositions.find((p) => p.symbol === symbol)?.qty ?? 0;
      const magnitude = Math.abs(leaderQty);
      const sized = magnitude > 0 ? computeFollowerQty(magnitude, { mode: group.sizingMode as SizingMode, multiplierMilli: f.sizingMultiplierMilli, fixedQty: f.sizingFixedQty }).qty : 0;
      const expected = leaderQty === 0 ? 0 : Math.sign(leaderQty) * sized;
      const actual = actualBySym.get(symbol) ?? 0;
      const delta = expected - actual;
      const inSync = delta === 0;
      if (!inSync) diverged.add(a.id);
      // Only surface rows that matter (a mismatch, or a nonzero expected/actual).
      if (!inSync || expected !== 0 || actual !== 0) {
        deltas.push({
          accountId: a.id, publicId: a.publicId, symbol,
          expectedQty: expected, actualQty: actual, deltaQty: delta,
          side: delta === 0 ? null : delta > 0 ? 'BUY' : 'SELL', inSync,
        });
      }
    }
  }
  const status: GroupSyncStatus = group.status === 'PAUSED' ? 'PAUSED' : diverged.size > 0 ? 'DIVERGED' : 'SYNCED';
  return { groupId, status, followers: deltas, divergedAccountIds: [...diverged] };
}

/**
 * Execute a resync: for each follower delta, submit a market order to close the
 * gap through the normal pipeline. Reuses the fan-out orchestrator so each order
 * is risk-validated and recorded; a resync order can be rejected. Never silent —
 * the caller has reviewed the deltas from `groupSyncView`.
 */
export async function executeResync(
  db: Database,
  execution: ExecutionProvider,
  input: { userId: string; groupId: string; idempotencyKey: string },
): Promise<CopyIntentResult[]> {
  const view = await groupSyncView(db, input.userId, input.groupId);
  if (view.status === 'DISABLED' || view.status === 'PAUSED') {
    throw new CopyGroupError('INVALID_STATE', `Cannot resync a ${view.status.toLowerCase()} group.`);
  }
  // One market order per (follower, symbol) with a nonzero delta, addressed to
  // that single account. We use per-account single-child submits so the risk
  // pipeline validates each, and the leader is not re-traded.
  const toFix = view.followers.filter((d) => d.deltaQty !== 0);
  const results: CopyIntentResult[] = [];
  for (const d of toFix) {
    const res = await submitCopyIntentForAccount(db, execution, {
      userId: input.userId,
      groupId: input.groupId,
      accountId: d.accountId,
      idempotencyKey: `${input.idempotencyKey}:${d.accountId}:${d.symbol}`,
      symbol: d.symbol,
      side: d.side!,
      qty: Math.abs(d.deltaQty),
    });
    results.push(res);
  }
  await events.publish(db, { type: 'copy.group.resynced', organizationId: null, userId: input.userId, payload: { groupId: input.groupId, orders: toFix.length } }).catch(() => undefined);
  return results;
}

// A thin single-account submit that reuses the orchestrator's intent/child
// recording by targeting a resync order at one follower. Implemented in the
// orchestrator to keep child/intent bookkeeping in one place.
import { submitResyncOrder } from './copy-orchestrator.js';
async function submitCopyIntentForAccount(
  db: Database,
  execution: ExecutionProvider,
  input: { userId: string; groupId: string; accountId: string; idempotencyKey: string; symbol: string; side: 'BUY' | 'SELL'; qty: number },
): Promise<CopyIntentResult> {
  return submitResyncOrder(db, execution, input);
}
