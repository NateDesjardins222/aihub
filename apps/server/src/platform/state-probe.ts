/**
 * Cross-system state probe (DEVELOPMENT / TEST ONLY).
 *
 * A READ-ONLY snapshot of everything authoritative about one account, gathered
 * from the same tables the product's own read paths use. Behavioral tests use it
 * to compare "truth across layers" for one account, and a developer can run the
 * CLI (`scripts/state-probe.ts`) against the dev DB during manual acceptance.
 *
 * This is NOT a production admin backdoor: it performs only SELECTs, mutates
 * nothing, exposes no HTTP surface, and the CLI refuses to run in production.
 * It is imported by tests and by the dev CLI only — never mounted on the app.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accounts,
  orders,
  positions,
  trades,
  riskEvents,
  auditLog,
  payoutRequests,
  enforcementHolds,
} from '../db/schema.js';
import { loadPersonalConfig } from '../trading/personal-risk-store.js';
import type { PersonalControlType } from '@atlas/contracts';

export interface AccountStateSnapshot {
  readonly accountId: string;
  readonly found: boolean;
  readonly account: {
    publicId: string;
    userId: string;
    name: string;
    accountType: string;
    status: string;
    ruleStatus: string;
    adminHold: string | null;
    startingBalanceMicros: number;
    balanceMicros: number;
    realizedPnlMicros: number;
    feesMicros: number;
    highWaterMarkMicros: number;
    drawdownFloorMicros: number;
    tradingDaysCount: number;
    winningDaysCount: number;
    bestDayProfitMicros: number;
    lockedUntilDate: string | null;
    currentTradeDate: string | null;
    dayStartBalanceMicros: number;
    dayStartEquityMicros: number;
    profileVersionId: string | null;
    ruleTemplateId: string | null;
  } | null;
  /** Enabled personal risk controls, keyed by control type. */
  readonly personalControls: Array<{
    controlType: PersonalControlType;
    enabled: boolean;
    mode: string;
    valueMicros: number | null;
    valueInt: number | null;
    lockedTradingDay: string | null;
    version: number;
  }>;
  readonly openPositions: Array<{ symbol: string; qty: number; avgPriceTicks: number | null }>;
  readonly recentOrders: Array<{ id: string; symbol: string; side: string; qty: number; type: string; status: string; createdAt: string | null }>;
  readonly recentTrades: number;
  readonly activeHolds: Array<{ id: string; capability: string; status: string; reasonCode: string }>;
  readonly payouts: Array<{ id: string; status: string | null; amountMicros: number | null }>;
  readonly recentRiskEvents: Array<{ reason: string; rule: string; createdAt: string | null }>;
  readonly recentAudit: Array<{ action: string | null; actorLabel: string | null; createdAt: string | null }>;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : v == null ? 0 : Number(v);
}
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Gather the authoritative cross-layer snapshot for one account (read-only). */
export async function probeAccountState(db: Database, accountId: string): Promise<AccountStateSnapshot> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!acct) {
    return {
      accountId, found: false, account: null, personalControls: [], openPositions: [],
      recentOrders: [], recentTrades: 0, activeHolds: [], payouts: [], recentRiskEvents: [], recentAudit: [],
    };
  }

  const config = await loadPersonalConfig(db, accountId);
  const personalControls = [...config.values()].map((c) => ({
    controlType: c.controlType,
    enabled: c.enabled,
    mode: c.mode,
    valueMicros: c.valueMicros ?? null,
    valueInt: c.valueInt ?? null,
    lockedTradingDay: c.lockedTradingDay ?? null,
    version: c.version,
  }));

  const posRows = await db.select().from(positions).where(eq(positions.accountId, accountId));
  const openPositions = posRows
    .filter((p) => num((p as Record<string, unknown>)['qty']) !== 0)
    .map((p) => {
      const r = p as Record<string, unknown>;
      return { symbol: String(r['symbol']), qty: num(r['qty']), avgPriceTicks: r['avgPriceTicks'] == null ? null : num(r['avgPriceTicks']) };
    });

  const orderRows = await db.select().from(orders).where(eq(orders.accountId, accountId)).orderBy(desc(orders.createdAt)).limit(10);
  const recentOrders = orderRows.map((o) => {
    const r = o as Record<string, unknown>;
    return { id: String(r['id']), symbol: String(r['symbol']), side: String(r['side']), qty: num(r['qty']), type: String(r['type']), status: String(r['status']), createdAt: iso(r['createdAt']) };
  });

  const tradeRows = await db.select().from(trades).where(eq(trades.accountId, accountId));

  let activeHolds: AccountStateSnapshot['activeHolds'] = [];
  try {
    // Holds are keyed by scope/scopeId; an account-scoped hold uses scopeId = accountId.
    const holdRows = await db
      .select()
      .from(enforcementHolds)
      .where(and(eq(enforcementHolds.scope, 'ACCOUNT'), eq(enforcementHolds.scopeId, accountId), eq(enforcementHolds.status, 'ACTIVE')));
    activeHolds = holdRows.map((h) => {
      const r = h as Record<string, unknown>;
      return { id: String(r['id']), capability: String(r['capability']), status: String(r['status']), reasonCode: String(r['reasonCode']) };
    });
  } catch { /* table shape variance — leave empty */ }

  let payouts: AccountStateSnapshot['payouts'] = [];
  try {
    const payRows = await db.select().from(payoutRequests).where(eq(payoutRequests.accountId, accountId)).limit(20);
    payouts = payRows.map((p) => {
      const r = p as Record<string, unknown>;
      return { id: String(r['id']), status: r['status'] == null ? null : String(r['status']), amountMicros: r['amountMicros'] == null ? null : num(r['amountMicros']) };
    });
  } catch { /* leave empty */ }

  let recentRiskEvents: AccountStateSnapshot['recentRiskEvents'] = [];
  try {
    const reRows = await db.select().from(riskEvents).where(eq(riskEvents.accountId, accountId)).orderBy(desc(riskEvents.createdAt)).limit(10);
    recentRiskEvents = reRows.map((e) => {
      const r = e as Record<string, unknown>;
      // risk_events stores `reason_code` (+ `rule`), not `reason`/`message`.
      return { reason: String(r['reasonCode'] ?? ''), rule: String(r['rule'] ?? ''), createdAt: iso(r['createdAt']) };
    });
  } catch { /* leave empty */ }

  let recentAudit: AccountStateSnapshot['recentAudit'] = [];
  try {
    const auRows = await db.select().from(auditLog).where(eq(auditLog.subjectId, accountId)).orderBy(desc(auditLog.createdAt)).limit(10);
    recentAudit = auRows.map((a) => {
      const r = a as Record<string, unknown>;
      return { action: r['action'] == null ? null : String(r['action']), actorLabel: r['actorLabel'] == null ? null : String(r['actorLabel']), createdAt: iso(r['createdAt']) };
    });
  } catch { /* leave empty */ }

  const a = acct as Record<string, unknown>;
  return {
    accountId,
    found: true,
    account: {
      publicId: String(a['publicId']),
      userId: String(a['userId']),
      name: String(a['name']),
      accountType: String(a['accountType']),
      status: String(a['status']),
      ruleStatus: String(a['ruleStatus']),
      adminHold: a['adminHold'] == null ? null : String(a['adminHold']),
      startingBalanceMicros: num(a['startingBalanceMicros']),
      balanceMicros: num(a['balanceMicros']),
      realizedPnlMicros: num(a['realizedPnlMicros']),
      feesMicros: num(a['feesMicros']),
      highWaterMarkMicros: num(a['highWaterMarkMicros']),
      drawdownFloorMicros: num(a['drawdownFloorMicros']),
      tradingDaysCount: num(a['tradingDaysCount']),
      winningDaysCount: num(a['winningDaysCount']),
      bestDayProfitMicros: num(a['bestDayProfitMicros']),
      lockedUntilDate: iso(a['lockedUntilDate']),
      currentTradeDate: iso(a['currentTradeDate']),
      dayStartBalanceMicros: num(a['dayStartBalanceMicros']),
      dayStartEquityMicros: num(a['dayStartEquityMicros']),
      profileVersionId: a['profileVersionId'] == null ? null : String(a['profileVersionId']),
      ruleTemplateId: a['ruleTemplateId'] == null ? null : String(a['ruleTemplateId']),
    },
    personalControls,
    openPositions,
    recentOrders,
    recentTrades: tradeRows.length,
    activeHolds,
    payouts,
    recentRiskEvents,
    recentAudit,
  };
}
