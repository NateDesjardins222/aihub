/**
 * Lifecycle + payout state-machine simulator (Engineering Resilience Phase 3).
 *
 * A TEST-ONLY driver that applies high-level authoritative actions against the
 * REAL backend (direct domain calls on a shared db — no HTTP, so it is fast enough
 * to explore large state spaces) while keeping a lightweight reference MODEL of
 * what should be true. It is deliberately simpler than production: it models only
 * the entities and relationships the invariant ledger cares about, and leans on the
 * Phase-1 integrity checks + Phase-2 reconciliation oracle as the invariant oracle.
 *
 * Every action either succeeds or fails safely (a rejected illegal action is caught
 * and recorded); after meaningful transitions the caller runs {@link Sim.check},
 * which asserts NO invariant became false for this run's entities.
 */
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import {
  accounts, dailyAccountStats, payoutLedger, payoutRequests, users,
} from '../../../db/schema.js';
import { hashPassword } from '../../../auth/password.js';
import { provisionAccount } from '../../provisioning.js';
import { resolveProfileByKey } from '../../profiles.js';
import { certifyEvaluation, approveFunding, markOrderCompleted } from '../../commerce.js';
import { createResetOrder } from '../../account-reset.js';
import { fulfillPurchaseGated } from '../../commerce-fulfillment.js';
import { ensureCustomerIdentity } from '../../customer-identity.js';
import { addDestination } from '../../payout-destinations.js';
import { requestPayout } from '../../payouts.js';
import { getOperationByRequest, ingestProviderEvent, runFastLane, submitPayable, failPayout } from '../../payout-operations.js';
import { mockPayoutProvider } from '../../payout-provider-registry.js';
import { MAX_ACTIVE_ACCOUNTS, countActiveAccounts } from '../../account-limit.js';
import { runIntegrityChecks } from '../integrity-checks.js';
import { reconcileAccount } from '../reconcile.js';
import { fnv1a } from './prng.js';

const M = 1_000_000;
const $ = (d: number) => d * M;

export interface AcctModel {
  id: string;
  userId: string;
  role: 'EVAL' | 'FUNDED';
  /** Coarse model status used only to pick plausible actions. */
  status: 'ACTIVE' | 'PASSED' | 'FAILED' | 'FUNDED' | 'COMPLETED';
  resetOf?: string;
  qualId?: string;
}

export interface ActionOutcome {
  action: string;
  ok: boolean;
  error?: string;
  detail?: string;
}

export class Sim {
  readonly userIds: string[] = [];
  readonly accounts = new Map<string, AcctModel>();
  readonly quals = new Map<string, { accountId: string; funded: boolean }>();
  readonly payouts = new Map<string, { accountId: string; state: string; idemKey: string }>();
  readonly history: ActionOutcome[] = [];

  constructor(
    readonly db: Database,
    readonly organizationId: string,
    readonly evalKey: string,
  ) {}

  private rec(o: ActionOutcome): ActionOutcome {
    this.history.push(o);
    return o;
  }

  // ---- entity accessors used by the generator -----------------------------
  evalAccounts(): AcctModel[] { return [...this.accounts.values()].filter((a) => a.role === 'EVAL'); }
  fundedAccounts(): AcctModel[] { return [...this.accounts.values()].filter((a) => a.role === 'FUNDED'); }
  byStatus(s: AcctModel['status']): AcctModel[] { return [...this.accounts.values()].filter((a) => a.status === s); }

  // ---- actions ------------------------------------------------------------
  async createCustomer(label: string): Promise<string> {
    const [u] = await this.db.insert(users).values({
      email: `sm-${label}-${crypto.randomUUID().slice(0, 8)}@atlas.test`, passwordHash: await hashPassword('pw'),
      displayName: label, organizationId: this.organizationId,
    }).returning();
    this.userIds.push(u!.id);
    await ensureCustomerIdentity(this.db, { organizationId: this.organizationId, userId: u!.id });
    this.rec({ action: 'CREATE_CUSTOMER', ok: true, detail: u!.id });
    return u!.id;
  }

  async provisionEval(userId: string, opts: { enforceLimit: boolean; idemKey?: string }): Promise<ActionOutcome> {
    const product = await resolveProfileByKey(this.db, this.organizationId, this.evalKey);
    try {
      const r = await provisionAccount(this.db, {
        organizationId: this.organizationId, userId, profileVersionId: product.versionId,
        activate: true, enforceActiveLimit: opts.enforceLimit, idempotencyKey: opts.idemKey,
      });
      if (!this.accounts.has(r.accountId)) {
        this.accounts.set(r.accountId, { id: r.accountId, userId, role: 'EVAL', status: 'ACTIVE' });
      }
      return this.rec({ action: 'PROVISION_EVAL', ok: true, detail: r.accountId });
    } catch (e) {
      return this.rec({ action: 'PROVISION_EVAL', ok: false, error: errStr(e) });
    }
  }

  /** Replay a provisioning with a reused idempotency key — must be idempotent. */
  async replayProvision(userId: string, idemKey: string): Promise<ActionOutcome> {
    return this.provisionEval(userId, { enforceLimit: false, idemKey });
  }

  /** Model a breach outcome: set the eval account FAILED (a legitimate terminal state). */
  async failEval(a: AcctModel): Promise<ActionOutcome> {
    if (a.role !== 'EVAL' || a.status !== 'ACTIVE') return this.rec({ action: 'FAIL_EVAL', ok: false, error: 'not-active-eval' });
    await this.db.update(accounts).set({ status: 'FAILED', ruleStatus: 'FAILED' }).where(eq(accounts.id, a.id));
    a.status = 'FAILED';
    return this.rec({ action: 'FAIL_EVAL', ok: true, detail: a.id });
  }

  async reset(a: AcctModel): Promise<ActionOutcome> {
    try {
      const { orderId } = await createResetOrder(this.db, { organizationId: this.organizationId, userId: a.userId, failedAccountId: a.id });
      await markOrderCompleted(this.db, orderId);
      const r = await fulfillPurchaseGated(this.db, orderId, { enforceGate: false });
      if (r.status === 'PROVISIONED' && (r as { accountId?: string }).accountId) {
        const succ = (r as { accountId: string }).accountId;
        if (!this.accounts.has(succ)) this.accounts.set(succ, { id: succ, userId: a.userId, role: 'EVAL', status: 'ACTIVE', resetOf: a.id });
      }
      return this.rec({ action: 'RESET', ok: true, detail: a.id });
    } catch (e) {
      return this.rec({ action: 'RESET', ok: false, error: errStr(e) });
    }
  }

  async certify(a: AcctModel): Promise<ActionOutcome> {
    try {
      const [acct] = await this.db.select().from(accounts).where(eq(accounts.id, a.id));
      // Make it passable (balance over target) only if currently active.
      if (acct && acct.status === 'ACTIVE') {
        const passing = acct.startingBalanceMicros + $(3_500);
        await this.db.update(accounts).set({ balanceMicros: passing, highWaterMarkMicros: passing }).where(eq(accounts.id, a.id));
      }
      const qual = await certifyEvaluation(this.db, a.id);
      if (qual) {
        a.status = 'PASSED';
        a.qualId = qual.id;
        this.quals.set(qual.id, { accountId: a.id, funded: false });
        return this.rec({ action: 'CERTIFY', ok: true, detail: qual.id });
      }
      return this.rec({ action: 'CERTIFY', ok: true, detail: 'no-qual' });
    } catch (e) {
      return this.rec({ action: 'CERTIFY', ok: false, error: errStr(e) });
    }
  }

  async fund(qualId: string): Promise<ActionOutcome> {
    try {
      const funded = await approveFunding(this.db, qualId, { actor: { type: 'SYSTEM', label: 'sim' } });
      const q = this.quals.get(qualId);
      if (q) q.funded = true;
      const fa = funded.fundedAccountId;
      if (fa && !this.accounts.has(fa)) {
        const src = q ? this.accounts.get(q.accountId) : undefined;
        this.accounts.set(fa, { id: fa, userId: src?.userId ?? '', role: 'FUNDED', status: 'FUNDED', qualId });
      }
      return this.rec({ action: 'FUND', ok: true, detail: funded.fundedAccountId ?? '' });
    } catch (e) {
      return this.rec({ action: 'FUND', ok: false, error: errStr(e) });
    }
  }

  /** Seed a funded account so a payout request can succeed (winning days + balance + destination). */
  async makePayoutEligible(a: AcctModel): Promise<void> {
    const [acct] = await this.db.select().from(accounts).where(eq(accounts.id, a.id));
    if (!acct) return;
    await this.db.update(accounts).set({
      balanceMicros: $(53_000), startingBalanceMicros: $(50_000), realizedPnlMicros: $(3_000), feesMicros: 0,
      dayStartBalanceMicros: $(53_000), dayStartEquityMicros: $(53_000), highWaterMarkMicros: $(53_000),
      activatedAt: new Date('2026-02-01T00:00:00Z'),
    }).where(eq(accounts.id, a.id));
    for (let i = 0; i < 5; i += 1) {
      await this.db.insert(dailyAccountStats).values({
        accountId: a.id, tradeDate: `2026-03-0${i + 1}`, startingBalanceMicros: $(50_000),
        endingBalanceMicros: $(50_200), highEquityMicros: $(50_200), lowEquityMicros: $(50_000), counted: true,
      }).onConflictDoNothing();
    }
    const identity = await ensureCustomerIdentity(this.db, { organizationId: this.organizationId, userId: a.userId });
    await addDestination(this.db, { organizationId: this.organizationId, customerIdentityId: identity.id, provider: 'MOCK', providerRef: `mock_${a.id.slice(0, 8)}` }).catch(() => undefined);
  }

  async requestPayoutFor(a: AcctModel, gross = $(1000), idemKey?: string): Promise<ActionOutcome> {
    const key = idemKey ?? `preq-${a.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const r = await requestPayout(this.db, { accountId: a.id, userId: a.userId, requestedGrossMicros: gross, idempotencyKey: key, actor: { type: 'SYSTEM', label: 'sim' } });
      this.payouts.set(r.id, { accountId: a.id, state: 'REQUESTED', idemKey: key });
      return this.rec({ action: 'REQUEST_PAYOUT', ok: true, detail: r.id });
    } catch (e) {
      return this.rec({ action: 'REQUEST_PAYOUT', ok: false, error: errStr(e) });
    }
  }

  async approveAndSubmit(requestId: string): Promise<ActionOutcome> {
    try {
      await runFastLane(this.db, requestId);
      await submitPayable(this.db, requestId);
      const p = this.payouts.get(requestId); if (p) p.state = 'SUBMITTED';
      return this.rec({ action: 'APPROVE_PAYOUT', ok: true, detail: requestId });
    } catch (e) {
      return this.rec({ action: 'APPROVE_PAYOUT', ok: false, error: errStr(e) });
    }
  }

  private async opKey(requestId: string): Promise<string | null> {
    const op = await getOperationByRequest(this.db, requestId);
    return op?.idempotencyKey ?? null;
  }

  async providerEvent(requestId: string, status: 'PAID' | 'FAILED'): Promise<ActionOutcome> {
    try {
      const key = await this.opKey(requestId);
      if (!key) return this.rec({ action: `PROVIDER_${status}`, ok: false, error: 'no-op' });
      const hook = mockPayoutProvider().advance(key, status);
      if (!hook) return this.rec({ action: `PROVIDER_${status}`, ok: false, error: 'no-hook' });
      await ingestProviderEvent(this.db, {
        organizationId: this.organizationId, provider: 'MOCK', providerEventId: hook.providerEventId,
        providerPayoutId: hook.providerPayoutId, normalizedType: status === 'PAID' ? 'PAYOUT_PAID' : 'PAYOUT_FAILED',
      });
      const p = this.payouts.get(requestId); if (p) p.state = status;
      return this.rec({ action: `PROVIDER_${status}`, ok: true, detail: requestId });
    } catch (e) {
      return this.rec({ action: `PROVIDER_${status}`, ok: false, error: errStr(e) });
    }
  }

  /** Re-deliver the SAME provider event id — must dedupe (no second business effect). */
  async duplicateCallback(requestId: string, status: 'PAID' | 'FAILED'): Promise<ActionOutcome> {
    return this.providerEvent(requestId, status);
  }

  /** Directly re-run failPayout — must be idempotent (no second reversal). */
  async retryFail(requestId: string): Promise<ActionOutcome> {
    try {
      await failPayout(this.db, requestId);
      return this.rec({ action: 'RETRY_FAIL', ok: true, detail: requestId });
    } catch (e) {
      return this.rec({ action: 'RETRY_FAIL', ok: false, error: errStr(e) });
    }
  }

  // ---- invariant oracle ---------------------------------------------------
  /**
   * Assert NO invariant became false for this run's entities. Returns a list of
   * violation strings (empty = clean). Combines the Phase-1 integrity checks
   * (filtered to our users/accounts) with business assertions and, for funded
   * accounts, the Phase-2 balance/ledger reconciliation.
   */
  async check(opts: { reconcile?: boolean } = {}): Promise<string[]> {
    const violations: string[] = [];
    const ours = new Set<string>([...this.accounts.keys(), ...this.userIds]);

    const findings = await runIntegrityChecks(this.db);
    for (const f of findings) {
      const mine = f.sample.filter((s) => ours.has(s));
      if (mine.length > 0) violations.push(`${f.check}[${f.severity}]: ${mine.join(',')}`);
    }

    // Business: active-account cap per user (mirrors ACTIVE_ACCOUNTS_OVER_CAP, belt-and-suspenders).
    for (const userId of this.userIds) {
      const active = await countActiveAccounts(this.db, userId);
      if (active > MAX_ACTIVE_ACCOUNTS) violations.push(`ACTIVE_CAP user=${userId} count=${active}`);
    }

    // Money: for every funded account, the balance identity + ledger arithmetic must hold.
    if (opts.reconcile) {
      for (const a of this.fundedAccounts()) {
        const lines = (await reconcileAccount(this.db, a.id)).filter((l) => l.kind === 'BALANCE_IDENTITY' || l.kind === 'LEDGER_ARITHMETIC');
        for (const l of lines) violations.push(`RECON ${l.kind} acct=${a.id} delta=${l.delta}`);
      }
    }
    return violations;
  }

  /**
   * A normalized digest of this run's business state — stable across DB id
   * churn (entities are numbered by insertion order, not by uuid) so the same
   * seed produces the same digest. Includes account roles/states, reset/funded
   * relationships, payout states, per-funded balance + net ledger movement.
   */
  async digest(): Promise<string> {
    const idNum = new Map<string, number>();
    let n = 0;
    const num = (id: string | undefined | null): string => {
      if (!id) return '-';
      if (!idNum.has(id)) idNum.set(id, (n += 1));
      return `#${idNum.get(id)}`;
    };
    // Deterministic entity order: sort accounts by (role, insertion order in map).
    const accts = [...this.accounts.values()];
    const rows: string[] = [];
    for (const a of accts) {
      const [dbRow] = await this.db.select().from(accounts).where(eq(accounts.id, a.id));
      if (!dbRow) continue;
      const ledger = await this.db.select({ t: payoutLedger.entryType, amt: payoutLedger.amountMicros })
        .from(payoutLedger).where(eq(payoutLedger.accountId, a.id));
      let net = 0;
      for (const l of ledger) net += l.t === 'DEBIT' ? l.amt : l.t === 'REVERSAL' ? -l.amt : 0;
      rows.push([
        num(a.id), a.role, dbRow.status, num(dbRow.resetOfAccountId), num(dbRow.sourceQualificationId),
        dbRow.balanceMicros, dbRow.realizedPnlMicros, dbRow.drawdownFloorMicros, net,
      ].join(':'));
    }
    rows.sort();
    // Payout request states.
    const preqs = await this.db.select({ id: payoutRequests.id, acct: payoutRequests.accountId, state: payoutRequests.state })
      .from(payoutRequests).where(inArray(payoutRequests.accountId, accts.map((a) => a.id).length ? accts.map((a) => a.id) : ['00000000-0000-0000-0000-000000000000']));
    const prows = preqs.map((p) => `${num(p.acct)}:${p.state}`).sort();
    return fnv1a(rows.join('|') + '#' + prows.join('|'));
  }
}

function errStr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 80);
}

export { M, $ };
