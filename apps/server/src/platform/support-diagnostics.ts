/**
 * Deterministic support diagnostics — the "What Happened?" panel (Milestone 12-F).
 *
 * Everything here reads SERVER-AUTHORITATIVE facts and reason codes from the real
 * engines (order reject reasons, payout eligibility, account drawdown/status,
 * provisioning, refund eligibility). No generative guessing: a support agent sees
 * what the system recorded, with the reason code, not an opinion.
 */
import { and, count, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { certificates, commercialOrders, executions, orders } from '../db/schema.js';
import { inspectAccount, inspectPayout } from './inspectors.js';
import { orderAccountId } from './commerce-fulfillment.js';

export interface Diagnostic {
  readonly objectType: string;
  readonly objectId: string;
  readonly headline: string;
  readonly facts: Array<{ label: string; value: string }>;
  readonly reasonCodes: string[];
}

const money = (m: number | null | undefined) => (m == null ? '—' : `$${(m / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/**
 * Ordinary purchase refund eligibility: allowed only if the provisioned account
 * has NO executed trade. A duplicate charge or a platform-caused issue is a
 * separate remediation path, not this ordinary check.
 */
export async function refundEligibility(db: Database, organizationId: string, orderId: string): Promise<{ eligible: boolean; reason: string; detail: Record<string, unknown> }> {
  const [order] = await db.select().from(commercialOrders).where(and(eq(commercialOrders.id, orderId), eq(commercialOrders.organizationId, organizationId)));
  if (!order) return { eligible: false, reason: 'ORDER_NOT_FOUND', detail: {} };
  if (order.refundedAt) return { eligible: false, reason: 'ALREADY_REFUNDED', detail: { refundedAt: order.refundedAt } };
  if (order.status !== 'COMPLETED' && order.status !== 'PROVISIONED') return { eligible: false, reason: `ORDER_NOT_SETTLED:${order.status}`, detail: { status: order.status } };
  const accountId = await orderAccountId(db, orderId);
  if (!accountId) return { eligible: true, reason: 'NO_ACCOUNT_PROVISIONED', detail: { note: 'No account was provisioned; ordinary refund is unblocked.' } };
  const execRows = await db.select({ n: count() }).from(executions).where(eq(executions.accountId, accountId));
  const n = Number(execRows[0]?.n ?? 0);
  const executed = n > 0;
  return executed
    ? { eligible: false, reason: 'TRADE_EXECUTED', detail: { accountId, executions: Number(n) } }
    : { eligible: true, reason: 'NO_TRADE_EXECUTED', detail: { accountId, executions: 0 } };
}

/** Build a deterministic diagnostic for a linked object. */
export async function whatHappened(db: Database, organizationId: string, objectType: string, objectId: string): Promise<Diagnostic> {
  const base = (headline: string, facts: Diagnostic['facts'], reasonCodes: string[] = []): Diagnostic => ({ objectType, objectId, headline, facts, reasonCodes });
  try {
    switch (objectType) {
      case 'order': {
        const [o] = await db.select().from(orders).where(eq(orders.id, objectId));
        if (!o) return base('Order not found', []);
        const facts = [
          { label: 'Symbol', value: o.symbol }, { label: 'Side', value: o.side }, { label: 'Qty', value: String(o.qty) },
          { label: 'Type', value: o.type }, { label: 'Status', value: o.status }, { label: 'Filled', value: String(o.filledQty) },
        ];
        if (o.rejectReason) facts.push({ label: 'Reject reason', value: o.rejectReason });
        const headline = o.status === 'REJECTED' ? `Order rejected: ${o.rejectReason ?? 'unspecified'}` : `Order ${o.status.toLowerCase()}`;
        return base(headline, facts, o.rejectReason ? [o.rejectReason] : []);
      }
      case 'payout': {
        const p = await inspectPayout(db, objectId);
        const e = p.eligibility;
        const facts = [
          { label: 'State', value: p.stateMachine.current },
          { label: 'Eligibility', value: e.state },
          { label: 'Withdrawable', value: money(e.grossWithdrawableMicros) },
          { label: 'Qualifying winning days', value: String(e.qualifyingWinningDays ?? '—') },
          { label: 'Consistency ratio', value: e.consistencyRatio != null ? `${(e.consistencyRatio * 100).toFixed(1)}%` : '—' },
        ];
        if (e.previousDailyQualifyingBalanceMicros != null) facts.push({ label: 'Previous qualifying balance', value: money(e.previousDailyQualifyingBalanceMicros) });
        if (e.currentQualifyingBalanceMicros != null) facts.push({ label: 'Current qualifying balance', value: money(e.currentQualifyingBalanceMicros) });
        if (e.requiredNextQualifyingBalanceMicros != null) facts.push({ label: 'Required next balance', value: money(e.requiredNextQualifyingBalanceMicros) });
        if (e.enforcementHold) facts.push({ label: 'Enforcement hold', value: 'YES' });
        return base(`Payout is ${p.stateMachine.current} (${e.state})`, facts, e.reasonCodes ?? []);
      }
      case 'account': {
        const a = await inspectAccount(db, objectId);
        const facts: Array<{ label: string; value: string }> = [
          { label: 'Status', value: String(a.status) }, { label: 'Rule status', value: String(a.ruleStatus ?? '—') },
          { label: 'Balance', value: money(a.balanceMicros) }, { label: 'Starting balance', value: money(a.startingBalanceMicros) },
          { label: 'Drawdown band', value: a.drawdown.band }, { label: 'Drawdown floor', value: money(a.drawdown.floorMicros) },
          { label: 'Headroom', value: money(a.drawdown.headroomMicros) },
        ];
        if (a.adminHold) facts.push({ label: 'Admin hold', value: String(a.adminHold) });
        if (a.tradingHold) facts.push({ label: 'Trading hold', value: 'YES' });
        const codes = a.drawdown.band === 'BREACHED' ? ['MAX_LOSS_BREACH'] : [];
        return base(`Account ${a.status} (${a.ruleStatus})`, facts, codes);
      }
      case 'purchase':
      case 'reset': {
        const [o] = await db.select().from(commercialOrders).where(eq(commercialOrders.id, objectId));
        if (!o) return base('Order not found', []);
        const accountId = await orderAccountId(db, objectId);
        const facts = [
          { label: 'Source', value: o.source }, { label: 'Status', value: o.status }, { label: 'Amount', value: money(o.amountMicros) },
          { label: 'Provisioned account', value: accountId ? accountId.slice(0, 8) : 'none' },
          { label: 'Refunded', value: o.refundedAt ? 'YES' : 'no' },
        ];
        if (o.provisionNote) facts.push({ label: 'Provision note', value: String(o.provisionNote) });
        const elig = await refundEligibility(db, organizationId, objectId);
        facts.push({ label: 'Ordinary refund eligibility', value: elig.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE' });
        return base(`${o.source} order is ${o.status}`, facts, [elig.reason]);
      }
      case 'certificate': {
        const [c] = await db.select().from(certificates).where(eq(certificates.id, objectId));
        if (!c) return base('Certificate not found', []);
        return base('Certificate', [
          { label: 'Type', value: c.type }, { label: 'Public id', value: c.certificatePublicId },
          { label: 'Status', value: String((c as Record<string, unknown>)['status'] ?? 'ISSUED') },
        ]);
      }
      default:
        return base(`No automated diagnostic for ${objectType}`, [{ label: 'Object', value: objectId }]);
    }
  } catch (e) {
    return base('Diagnostic unavailable', [{ label: 'Error', value: (e as Error).message.slice(0, 80) }]);
  }
}
