/**
 * Payout Operations pipeline (Milestone 8) — the straight-through-processing layer
 * that moves an eligible, requested payout to the provider fast and safely.
 *
 * It never changes who qualifies or how much: economics stay in payouts.ts. It
 * decides WHEN the economic transitions happen (fast lane vs. exception lane) and
 * drives them automatically for clean payouts. The money spine is unchanged:
 * approvePayout debits once at APPROVED; markPaid settles at PAID. This module
 * overlays that with the operational state, idempotent provider submission,
 * provider events, and reconciliation.
 *
 * Non-negotiables enforced here: no duplicate external payout; a lost
 * acknowledgement never causes a blind duplicate; HTTP 200 is not PAID (only an
 * authoritative provider PAID event/reconcile is); a treasury/provider block
 * delays but never denies eligibility; certificates fire only from PAID.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accounts, customerIdentities, payoutDestinations, payoutOperationalChecks, payoutOperations,
  payoutProviderEvents, payoutReconciliationRecords, payoutRequests, payoutSubmissionAttempts,
} from '../db/schema.js';
import { type Actor, SYSTEM_ACTOR } from './actor.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { accountAdvisoryLockSql } from '../trading/account-lock.js';
import { systemClock, type Clock } from './clock.js';
import { approvePayout, markPaid, markProcessing, PayoutError, type PayoutRow } from './payouts.js';
import { holdBlocking, resolveAccountOwnerIdentity } from './enforcement-holds.js';
import { ingestSignal } from './enforcement.js';
import { activeDestination, type DestinationRow } from './payout-destinations.js';
import { getOpsConfig, treasuryGate, type OpsConfigRow } from './payout-ops-config.js';
import { resolvePayoutProvider } from './payout-provider-registry.js';
import type { NormalizedEventType, PayoutProvider, SubmitPayoutResult } from './payout-provider.js';

export type OpRow = typeof payoutOperations.$inferSelect;

export type OpState =
  | 'RECEIVED' | 'AUTOMATED_CHECKS' | 'PAYABLE' | 'SUBMITTING' | 'SUBMITTED'
  | 'PROCESSING' | 'PAID' | 'RECONCILED' | 'EXCEPTION' | 'FAILED' | 'RETURNED' | 'CANCELED';

export type ExceptionCategory =
  | 'IDENTITY_REVIEW' | 'DESTINATION_REVIEW' | 'ENFORCEMENT_REVIEW' | 'TREASURY_REVIEW'
  | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'DUPLICATE_CONFLICT' | 'ACCOUNT_STATE_CONFLICT'
  | 'AMOUNT_CONFLICT' | 'SECURITY_REVIEW' | 'RETURNED_PAYMENT' | 'UNKNOWN_PROVIDER_STATE';

/** The customer-safe bucket shown in the portal — never the internal category. */
export function customerSafeFor(op: OpState, category?: ExceptionCategory | null): string {
  if (op === 'PAID' || op === 'RECONCILED') return 'PAID';
  if (op === 'PROCESSING') return 'PROCESSING';
  if (op === 'SUBMITTED' || op === 'SUBMITTING') return 'SENT';
  if (op === 'PAYABLE' || op === 'AUTOMATED_CHECKS' || op === 'RECEIVED') return 'PREPARING';
  if (op === 'FAILED') return 'FAILED';
  if (op === 'RETURNED' || category === 'RETURNED_PAYMENT') return 'RETURNED';
  return 'UNDER_REVIEW';
}

const MAX_SUBMISSION_ATTEMPTS = 5;

/** The stable, immutable idempotency identity. NEVER regenerated on retry. */
export function idempotencyKeyFor(payoutRequestId: string, ordinal: number, provider: string): string {
  return `${payoutRequestId}:${ordinal}:${provider}`;
}

// -- operation row lifecycle -------------------------------------------------

export async function getOperationByRequest(db: Database, payoutRequestId: string): Promise<OpRow | null> {
  const [row] = await db.select().from(payoutOperations).where(eq(payoutOperations.payoutRequestId, payoutRequestId));
  return row ?? null;
}

/** Create (idempotently) the operational overlay row for a payout request. */
export async function ensureOperation(db: Database, payoutRequestId: string, clock: Clock = systemClock): Promise<OpRow> {
  const existing = await getOperationByRequest(db, payoutRequestId);
  if (existing) return existing;
  const [request] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, payoutRequestId));
  if (!request) throw new PayoutError('PAYOUT_NOT_FOUND', 'No such payout request.');
  const config = await getOpsConfig(db, request.organizationId);
  const provider = config.provider ?? 'UNCONFIGURED';
  const owner = await resolveAccountOwnerIdentity(db, request.accountId);
  const idempotencyKey = idempotencyKeyFor(request.id, request.payoutOrdinal ?? 0, provider);
  const [created] = await db.insert(payoutOperations).values({
    organizationId: request.organizationId,
    payoutRequestId: request.id,
    accountId: request.accountId,
    customerIdentityId: owner?.customerIdentityId ?? null,
    provider,
    opState: 'RECEIVED',
    customerSafeCategory: 'PREPARING',
    idempotencyKey,
    requestedAt: clock.date(),
  }).onConflictDoNothing({ target: [payoutOperations.payoutRequestId] }).returning();
  if (created) return created;
  return (await getOperationByRequest(db, payoutRequestId))!;
}

async function patchOp(db: Database, opId: string, patch: Partial<OpRow>): Promise<OpRow> {
  const [row] = await db.update(payoutOperations)
    .set({ ...patch, updatedAt: new Date(), version: sql`${payoutOperations.version} + 1` })
    .where(eq(payoutOperations.id, opId)).returning();
  return row!;
}

async function recordCheck(db: Database, org: string, requestId: string, checkType: string, result: 'PASS' | 'FAIL' | 'SKIP', category?: ExceptionCategory, detail?: string): Promise<void> {
  await db.insert(payoutOperationalChecks).values({
    organizationId: org, payoutRequestId: requestId, checkType, result,
    category: category ?? null, detailSafe: detail?.slice(0, 300) ?? null,
  });
}

async function routeException(db: Database, op: OpRow, category: ExceptionCategory, detail: string, clock: Clock): Promise<OpRow> {
  const updated = await patchOp(db, op.id, {
    opState: 'EXCEPTION', exceptionCategory: category,
    customerSafeCategory: customerSafeFor('EXCEPTION', category),
    checksCompletedAt: op.checksCompletedAt ?? clock.date(), lastError: detail.slice(0, 300),
  });
  await recordAudit(db, {
    organizationId: op.organizationId, actor: SYSTEM_ACTOR, subjectType: 'ACCOUNT', subjectId: op.accountId, accountId: op.accountId,
    action: 'payout_ops.exception', newState: { payoutRequestId: op.payoutRequestId, category }, reason: detail,
  });
  await events.publish(db, { type: 'payout.exception', organizationId: op.organizationId, accountId: op.accountId, payload: { payoutRequestId: op.payoutRequestId, category } });
  return updated;
}

// -- operational checks ------------------------------------------------------

interface CheckOutcome { clean: boolean; category?: ExceptionCategory; detail?: string; destination?: DestinationRow | null }

/**
 * Deterministic, server-authoritative operational checks. Economic eligibility
 * is re-verified at approval; here we gate identity, destination, enforcement
 * hold, account state, duplicate movement, and treasury/provider readiness. Every
 * check is recorded append-only.
 */
export async function runOperationalChecks(db: Database, request: PayoutRow, config: OpsConfigRow): Promise<CheckOutcome> {
  const org = request.organizationId;
  const rid = request.id;
  const [account] = await db.select().from(accounts).where(eq(accounts.id, request.accountId));
  if (!account) return fail('ACCOUNT_STATE_CONFLICT', 'Account not found.');

  // ELIGIBILITY (shallow — deep re-verify happens at approve): request must be REQUESTED.
  if (request.state !== 'REQUESTED') {
    await recordCheck(db, org, rid, 'ELIGIBILITY', 'FAIL', 'ACCOUNT_STATE_CONFLICT', `state ${request.state}`);
    return { clean: false, category: 'ACCOUNT_STATE_CONFLICT', detail: `Payout is not in a requestable state (${request.state}).` };
  }
  await recordCheck(db, org, rid, 'ELIGIBILITY', 'PASS');

  // OWNERSHIP + IDENTITY.
  const owner = await resolveAccountOwnerIdentity(db, account.id);
  if (!owner) { await recordCheck(db, org, rid, 'OWNERSHIP', 'FAIL', 'IDENTITY_REVIEW'); return fail('IDENTITY_REVIEW', 'Account owner could not be resolved.'); }
  await recordCheck(db, org, rid, 'OWNERSHIP', 'PASS');
  if (owner.customerIdentityId) {
    const [ident] = await db.select().from(customerIdentities).where(eq(customerIdentities.id, owner.customerIdentityId));
    if (ident && ident.status !== 'ACTIVE') {
      await recordCheck(db, org, rid, 'IDENTITY', 'FAIL', 'IDENTITY_REVIEW', ident.status);
      return { clean: false, category: 'IDENTITY_REVIEW', detail: 'Identity verification is required before this payout.' };
    }
  }
  await recordCheck(db, org, rid, 'IDENTITY', 'PASS');

  // ENFORCEMENT HOLD (M7).
  const subject = { accountId: account.id, customerIdentityId: owner.customerIdentityId ?? null, payoutRequestId: request.id };
  if ((await holdBlocking(db, subject, 'PAYOUT_REQUEST')) || (await holdBlocking(db, subject, 'PAYOUT_APPROVAL'))) {
    await recordCheck(db, org, rid, 'ENFORCEMENT_HOLD', 'FAIL', 'ENFORCEMENT_REVIEW');
    return { clean: false, category: 'ENFORCEMENT_REVIEW', detail: 'This payout is temporarily under review.' };
  }
  await recordCheck(db, org, rid, 'ENFORCEMENT_HOLD', 'PASS');

  // ACCOUNT STATE — a disabled/closed account cannot receive a payout.
  if (account.status === 'DISABLED' || account.status === 'CLOSED') {
    await recordCheck(db, org, rid, 'ACCOUNT_STATE', 'FAIL', 'ACCOUNT_STATE_CONFLICT', account.status);
    return { clean: false, category: 'ACCOUNT_STATE_CONFLICT', detail: 'The account state does not permit a payout.' };
  }
  await recordCheck(db, org, rid, 'ACCOUNT_STATE', 'PASS');

  // DESTINATION — a verified/active destination on the configured provider.
  const provider = config.provider ?? 'UNCONFIGURED';
  const destination = owner.customerIdentityId ? await activeDestination(db, owner.customerIdentityId, provider) : null;
  if (!destination) {
    await recordCheck(db, org, rid, 'DESTINATION', 'FAIL', 'DESTINATION_REVIEW', 'no active destination');
    return { clean: false, category: 'DESTINATION_REVIEW', detail: 'A verified payout destination is required.' };
  }
  if (destination.ownershipState === 'OWNERSHIP_MISMATCH') {
    await recordCheck(db, org, rid, 'DESTINATION', 'FAIL', 'DESTINATION_REVIEW', 'ownership mismatch');
    // A mismatch is NOT automatically fraud — emit an M7 signal (a signal is not a finding).
    await emitSignalSafe(db, org, owner.customerIdentityId!, account.id, 'PAYOUT_DESTINATION_MISMATCH');
    return { clean: false, category: 'DESTINATION_REVIEW', detail: 'Your payout destination needs review.', destination };
  }
  await recordCheck(db, org, rid, 'DESTINATION', 'PASS');

  // DUPLICATE MOVEMENT — no other non-terminal op already submitting for this account+ordinal.
  const dupes = await db.select({ id: payoutOperations.id }).from(payoutOperations)
    .where(and(
      eq(payoutOperations.accountId, account.id),
      inArray(payoutOperations.opState, ['SUBMITTING', 'SUBMITTED', 'PROCESSING']),
      sql`${payoutOperations.payoutRequestId} <> ${request.id}`,
    ));
  if (dupes.length > 0) {
    await recordCheck(db, org, rid, 'DUPLICATE', 'FAIL', 'DUPLICATE_CONFLICT');
    return { clean: false, category: 'DUPLICATE_CONFLICT', detail: 'Another payout for this account is already in flight.' };
  }
  await recordCheck(db, org, rid, 'DUPLICATE', 'PASS');

  // AMOUNT — within the canonical available snapshot (deep re-verify at approve).
  if (request.withdrawableBeforeMicros != null && request.requestedGrossMicros > request.withdrawableBeforeMicros) {
    await recordCheck(db, org, rid, 'AMOUNT', 'FAIL', 'AMOUNT_CONFLICT');
    return { clean: false, category: 'AMOUNT_CONFLICT', detail: 'The requested amount exceeds the available balance.' };
  }
  await recordCheck(db, org, rid, 'AMOUNT', 'PASS');

  // TREASURY + PROVIDER readiness.
  const traderShare = request.traderShareMicros ?? request.requestedGrossMicros;
  const gate = await treasuryGate(db, org, traderShare, config);
  if (!gate.ok) {
    await recordCheck(db, org, rid, gate.category === 'PROVIDER_UNAVAILABLE' ? 'PROVIDER' : 'TREASURY', 'FAIL', gate.category, gate.reason);
    return { clean: false, category: gate.category, detail: gate.reason, destination };
  }
  await recordCheck(db, org, rid, 'TREASURY', 'PASS');
  await recordCheck(db, org, rid, 'PROVIDER', 'PASS');
  await recordCheck(db, org, rid, 'IDEMPOTENCY', 'PASS');

  return { clean: true, destination };

  function fail(category: ExceptionCategory, detail: string): CheckOutcome {
    return { clean: false, category, detail };
  }
}

async function emitSignalSafe(db: Database, org: string, identityId: string, accountId: string, kind: string): Promise<void> {
  try {
    await ingestSignal(db, {
      organizationId: org, source: 'PAYOUT', kind, customerIdentityId: identityId, accountId,
      dedupeKey: `payoutops:${kind}:${accountId}:${Date.now()}`, openCaseCategory: 'PAYOUT',
      metadata: { origin: 'payout-operations' }, actor: SYSTEM_ACTOR,
    });
  } catch { /* a signal must never break the payout pipeline */ }
}

// -- the fast lane -----------------------------------------------------------

export interface FastLaneResult { opState: OpState; exceptionCategory?: ExceptionCategory | null; approved: boolean }

/**
 * Straight-through processing: run the checks and, if clean, auto-approve (the
 * single balance debit) and mark the payout PAYABLE — with no human approval. A
 * failed check routes to the explicit exception lane. Idempotent: re-running on an
 * already-processed payout is a no-op.
 */
export async function runFastLane(db: Database, payoutRequestId: string, opts: { clock?: Clock; actor?: Actor } = {}): Promise<FastLaneResult> {
  const clock = opts.clock ?? systemClock;
  const [request] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, payoutRequestId));
  if (!request) throw new PayoutError('PAYOUT_NOT_FOUND', 'No such payout request.');
  const config = await getOpsConfig(db, request.organizationId);
  let op = await ensureOperation(db, payoutRequestId, clock);

  // Idempotency: once past checks, never re-run.
  if (!['RECEIVED', 'AUTOMATED_CHECKS', 'EXCEPTION'].includes(op.opState)) {
    return { opState: op.opState as OpState, exceptionCategory: op.exceptionCategory as ExceptionCategory | null, approved: op.approvedAt != null };
  }

  op = await patchOp(db, op.id, { opState: 'AUTOMATED_CHECKS', checksStartedAt: op.checksStartedAt ?? clock.date(), provider: config.provider ?? op.provider });
  const outcome = await runOperationalChecks(db, request, config);
  if (!outcome.clean) {
    const routed = await routeException(db, op, outcome.category!, outcome.detail ?? 'Routed to review.', clock);
    return { opState: routed.opState as OpState, exceptionCategory: routed.exceptionCategory as ExceptionCategory, approved: false };
  }

  op = await patchOp(db, op.id, { checksCompletedAt: clock.date(), destinationId: outcome.destination?.id ?? op.destinationId });

  // Approve — the single balance debit. Re-verifies eligibility + hold under lock.
  try {
    await approvePayout(db, { payoutRequestId, actor: opts.actor ?? SYSTEM_ACTOR });
  } catch (e) {
    if (e instanceof PayoutError && e.reason === 'ENFORCEMENT_HOLD') {
      const routed = await routeException(db, op, 'ENFORCEMENT_REVIEW', 'Held at approval.', clock);
      return { opState: routed.opState as OpState, exceptionCategory: 'ENFORCEMENT_REVIEW', approved: false };
    }
    if (e instanceof PayoutError) {
      const routed = await routeException(db, op, 'AMOUNT_CONFLICT', e.message, clock);
      return { opState: routed.opState as OpState, exceptionCategory: 'AMOUNT_CONFLICT', approved: false };
    }
    throw e;
  }

  op = await patchOp(db, op.id, {
    opState: 'PAYABLE', fastLane: true, approvedAt: clock.date(), payableAt: clock.date(),
    customerSafeCategory: 'PREPARING', exceptionCategory: null, lastError: null,
  });
  await events.publish(db, { type: 'payout.fast_lane_entered', organizationId: op.organizationId, accountId: op.accountId, payload: { payoutRequestId } });
  return { opState: 'PAYABLE', approved: true };
}

// -- durable provider submission --------------------------------------------

/**
 * Submit a PAYABLE payout to the provider. Claims the operation under a lock,
 * re-checks the treasury/circuit gate, and calls the provider with the SAME stable
 * idempotency key on every attempt. Handles accept/processing/paid, transient
 * retry, hard rejection, and — critically — a lost acknowledgement, which is
 * reconciled rather than blindly re-submitted. Never pays twice.
 */
export async function submitPayable(db: Database, payoutRequestId: string, opts: { clock?: Clock } = {}): Promise<OpRow> {
  const clock = opts.clock ?? systemClock;
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [op] = await tx.select().from(payoutOperations).where(eq(payoutOperations.payoutRequestId, payoutRequestId)).for('update');
    if (!op) throw new PayoutError('PAYOUT_NOT_FOUND', 'No operation for this payout.');
    // Idempotency: only a PAYABLE payout (or a retryable PAYABLE after transient) submits.
    if (op.opState !== 'PAYABLE') return op;
    await tx.execute(accountAdvisoryLockSql(op.accountId));

    const [request] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, payoutRequestId));
    const config = await getOpsConfig(scoped, op.organizationId);
    const traderShare = request!.traderShareMicros ?? request!.requestedGrossMicros;

    // Re-check the gate at submission time — the world may have changed.
    const gate = await treasuryGate(scoped, op.organizationId, traderShare, config);
    if (!gate.ok) {
      // Delayed, not denied: the payout stays economically APPROVED (owed).
      return routeException(scoped, op, gate.category, gate.reason, clock);
    }

    const provider = resolvePayoutProvider(op.provider);
    const [destination] = op.destinationId ? await tx.select().from(payoutDestinations).where(eq(payoutDestinations.id, op.destinationId)) : [undefined];
    const destinationRef = destination?.providerRef ?? 'mock_destination';

    const priorAttempts = await tx.select({ n: sql<number>`coalesce(count(*),0)::int` }).from(payoutSubmissionAttempts).where(eq(payoutSubmissionAttempts.payoutRequestId, payoutRequestId));
    const attemptNumber = (priorAttempts[0]?.n ?? 0) + 1;
    const correlationId = createHash('sha256').update(`${op.idempotencyKey}:${attemptNumber}`).digest('hex').slice(0, 32);
    const requestHash = createHash('sha256').update(`${op.idempotencyKey}:${traderShare}:${destinationRef}`).digest('hex').slice(0, 64);

    await patchOp(scoped, op.id, { opState: 'SUBMITTING', submissionStartedAt: op.submissionStartedAt ?? clock.date() });
    const [attempt] = await tx.insert(payoutSubmissionAttempts).values({
      organizationId: op.organizationId, payoutRequestId, provider: provider.id, idempotencyKey: op.idempotencyKey,
      attemptNumber, requestHash, correlationId, startedAt: clock.date(),
    }).returning();

    let result: SubmitPayoutResult;
    try {
      result = await provider.submitPayout({ idempotencyKey: op.idempotencyKey, amountMicros: traderShare, currency: 'USD', destinationRef, payoutRequestId, correlationId });
    } catch {
      // A thrown error is an unknown outcome — reconcile, never blind-retry.
      result = { outcome: 'LOST_ACK', status: 'UNKNOWN', errorCategory: 'TIMEOUT', retryable: false, message: 'submit threw' };
    }
    await tx.update(payoutSubmissionAttempts).set({
      completedAt: clock.date(), providerPayoutId: result.providerPayoutId ?? null,
      normalizedResult: mapOutcome(result.outcome), errorCategory: result.errorCategory, retryable: result.retryable,
    }).where(eq(payoutSubmissionAttempts.id, attempt!.id));

    return handleSubmitResult(scoped, op, result, { clock, attemptNumber, providerId: provider.id });
  });
}

function mapOutcome(o: SubmitPayoutResult['outcome']): string {
  switch (o) {
    case 'ACCEPTED': return 'ACCEPTED';
    case 'PROCESSING': return 'PROCESSING';
    case 'PAID': return 'PAID';
    case 'FAILED': return 'FAILED';
    case 'TIMEOUT': return 'TIMEOUT';
    case 'LOST_ACK': return 'LOST_ACK';
    case 'DUPLICATE': return 'ACCEPTED';
  }
}

async function handleSubmitResult(db: Database, op: OpRow, result: SubmitPayoutResult, ctx: { clock: Clock; attemptNumber: number; providerId: string }): Promise<OpRow> {
  const { clock } = ctx;
  switch (result.outcome) {
    case 'PAID':
    case 'ACCEPTED':
    case 'PROCESSING':
    case 'DUPLICATE': {
      const submitted = await patchOp(db, op.id, {
        opState: result.outcome === 'PROCESSING' ? 'PROCESSING' : 'SUBMITTED',
        submittedAt: op.submittedAt ?? clock.date(), providerPayoutId: result.providerPayoutId ?? op.providerPayoutId,
        customerSafeCategory: result.outcome === 'PROCESSING' ? 'PROCESSING' : 'SENT', lastError: null,
      });
      // Move the economic state to PROCESSING (from APPROVED). Idempotent.
      await markProcessing(db, { payoutRequestId: op.payoutRequestId, actor: SYSTEM_ACTOR }).catch(() => undefined);
      if (result.outcome === 'PROCESSING') await patchOp(db, op.id, { providerProcessingAt: op.providerProcessingAt ?? clock.date() });
      await events.publish(db, { type: 'payout.submitted', organizationId: op.organizationId, accountId: op.accountId, payload: { payoutRequestId: op.payoutRequestId } });
      // A provider that pays synchronously is honoured only via the authoritative path.
      if (result.outcome === 'PAID') return applyProviderPaid(db, submitted.payoutRequestId, { providerPayoutId: result.providerPayoutId, clock });
      return submitted;
    }
    case 'LOST_ACK':
    case 'TIMEOUT': {
      // Do NOT blind-retry. Reconcile against the provider using the same key.
      const provider = resolvePayoutProvider(op.provider);
      const found = await provider.getPayout({ idempotencyKey: op.idempotencyKey, providerPayoutId: op.providerPayoutId ?? undefined });
      if (found.found) {
        const submitted = await patchOp(db, op.id, { opState: found.status === 'PROCESSING' ? 'PROCESSING' : 'SUBMITTED', submittedAt: op.submittedAt ?? clock.date(), providerPayoutId: found.providerPayoutId ?? op.providerPayoutId, customerSafeCategory: found.status === 'PROCESSING' ? 'PROCESSING' : 'SENT' });
        await markProcessing(db, { payoutRequestId: op.payoutRequestId, actor: SYSTEM_ACTOR }).catch(() => undefined);
        await recordReconciliation(db, op, 'PROVIDER_AHEAD', found.status, true, { via: 'lost-ack-recovery' });
        if (found.status === 'PAID') return applyProviderPaid(db, op.payoutRequestId, { providerPayoutId: found.providerPayoutId, clock });
        return submitted;
      }
      return routeException(db, op, 'UNKNOWN_PROVIDER_STATE', 'Provider outcome could not be established after a lost acknowledgement.', clock);
    }
    case 'FAILED': {
      if (result.retryable && ctx.attemptNumber < MAX_SUBMISSION_ATTEMPTS) {
        // Leave PAYABLE so the worker retries with the SAME key, later.
        return patchOp(db, op.id, { opState: 'PAYABLE', lastError: (result.message ?? 'transient error').slice(0, 300) });
      }
      const category: ExceptionCategory = result.errorCategory === 'DESTINATION' ? 'DESTINATION_REVIEW'
        : result.errorCategory === 'AMOUNT' ? 'AMOUNT_CONFLICT'
        : result.errorCategory === 'OWNERSHIP' ? 'DESTINATION_REVIEW'
        : result.errorCategory === 'COMPLIANCE' ? 'SECURITY_REVIEW'
        : result.errorCategory === 'TRANSIENT' ? 'PROVIDER_UNAVAILABLE'
        : 'PROVIDER_REJECTED';
      if (result.errorCategory === 'OWNERSHIP' && op.customerIdentityId) {
        await emitSignalSafe(db, op.organizationId, op.customerIdentityId, op.accountId, 'PAYOUT_PROVIDER_OWNERSHIP_ISSUE');
      }
      return routeException(db, op, category, result.message ?? 'Provider rejected the payout.', clock);
    }
  }
}

// -- authoritative paid + reconciliation ------------------------------------

/**
 * Apply an authoritative provider PAID. Drives the existing markPaid (settlement
 * ledger + account completion + payout.paid → certificate, exactly once). HTTP
 * success alone never reaches here — only a PAID provider event/reconcile does.
 */
export async function applyProviderPaid(db: Database, payoutRequestId: string, opts: { providerPayoutId?: string; amountMicros?: number; clock?: Clock }): Promise<OpRow> {
  const clock = opts.clock ?? systemClock;
  const op = (await getOperationByRequest(db, payoutRequestId))!;
  if (op.opState === 'PAID' || op.opState === 'RECONCILED') return op; // idempotent
  await markPaid(db, { payoutRequestId, actor: SYSTEM_ACTOR });
  const updated = await patchOp(db, op.id, {
    opState: 'PAID', paidAt: op.paidAt ?? clock.date(), providerPayoutId: opts.providerPayoutId ?? op.providerPayoutId,
    customerSafeCategory: 'PAID', exceptionCategory: null,
  });
  // Amount reconciliation, if the provider reported one.
  if (opts.amountMicros != null) {
    const [request] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, payoutRequestId));
    const expected = request?.traderShareMicros ?? 0;
    if (opts.amountMicros !== expected) {
      await recordReconciliation(db, updated, 'AMOUNT_MISMATCH', 'PAID', false, { expected, provider: opts.amountMicros });
      if (op.customerIdentityId) await emitSignalSafe(db, op.organizationId, op.customerIdentityId, op.accountId, 'PAYOUT_AMOUNT_MISMATCH');
    }
  }
  return updated;
}

async function recordReconciliation(db: Database, op: OpRow, mismatchType: string, providerState: string | null, autoResolved: boolean, detail: Record<string, unknown>): Promise<void> {
  await db.insert(payoutReconciliationRecords).values({
    organizationId: op.organizationId, payoutRequestId: op.payoutRequestId, provider: op.provider ?? 'UNKNOWN',
    expectedState: op.opState, providerState, mismatchType,
    resolution: autoResolved ? 'AUTO_RESOLVED' : mismatchType === 'NONE' ? 'NO_ACTION' : 'ROUTED_EXCEPTION',
    autoResolved, detail: detail as object,
  });
}

// -- provider events (webhooks) ----------------------------------------------

export interface IngestEventInput {
  organizationId: string;
  provider: string;
  providerEventId: string;
  providerPayoutId?: string;
  normalizedType: NormalizedEventType;
  eventTs?: number;
  amountMicros?: number;
  payload?: Record<string, unknown>;
  clock?: Clock;
}

/**
 * Ingest a normalized provider event idempotently. Duplicate events (same
 * provider event id) are a no-op; out-of-order events never move a PAID payout
 * backwards. Only PAYOUT_PAID drives settlement.
 */
export async function ingestProviderEvent(db: Database, input: IngestEventInput): Promise<{ deduped: boolean; opState: OpState | null }> {
  const clock = input.clock ?? systemClock;
  const [inserted] = await db.insert(payoutProviderEvents).values({
    organizationId: input.organizationId, provider: input.provider, providerEventId: input.providerEventId,
    providerPayoutId: input.providerPayoutId ?? null, normalizedType: input.normalizedType,
    eventTs: input.eventTs ? new Date(input.eventTs) : null, payload: (input.payload ?? null) as object | null,
  }).onConflictDoNothing({ target: [payoutProviderEvents.provider, payoutProviderEvents.providerEventId] }).returning();
  if (!inserted) return { deduped: true, opState: null };

  // Resolve the operation by provider payout id.
  let op: OpRow | null = null;
  if (input.providerPayoutId) {
    const [row] = await db.select().from(payoutOperations).where(and(eq(payoutOperations.provider, input.provider), eq(payoutOperations.providerPayoutId, input.providerPayoutId)));
    op = row ?? null;
  }
  if (!op) { await db.update(payoutProviderEvents).set({ processingState: 'FAILED' }).where(eq(payoutProviderEvents.id, inserted.id)); return { deduped: false, opState: null }; }

  let opState: OpState = op.opState as OpState;
  // Out-of-order safety: never move a terminal PAID backwards.
  const terminal = op.opState === 'PAID' || op.opState === 'RECONCILED';
  switch (input.normalizedType) {
    case 'PAYOUT_ACCEPTED':
    case 'PAYOUT_PROCESSING':
      if (!terminal) {
        await markProcessing(db, { payoutRequestId: op.payoutRequestId, actor: SYSTEM_ACTOR }).catch(() => undefined);
        const u = await patchOp(db, op.id, { opState: 'PROCESSING', providerProcessingAt: op.providerProcessingAt ?? clock.date(), customerSafeCategory: 'PROCESSING' });
        opState = u.opState as OpState;
      }
      break;
    case 'PAYOUT_PAID': {
      const u = await applyProviderPaid(db, op.payoutRequestId, { providerPayoutId: op.providerPayoutId ?? input.providerPayoutId, amountMicros: input.amountMicros, clock });
      opState = u.opState as OpState;
      break;
    }
    case 'PAYOUT_FAILED':
      if (!terminal) {
        await failPayout(db, op.payoutRequestId).catch(() => undefined);
        const u = await patchOp(db, op.id, { opState: 'FAILED', customerSafeCategory: 'FAILED', lastError: 'provider failed' });
        opState = u.opState as OpState;
      }
      break;
    case 'PAYOUT_RETURNED': {
      // A payment came back. Record it; DO NOT delete historical certificate issuance.
      await recordReconciliation(db, op, 'LOCAL_AHEAD', 'RETURNED', false, { returned: true });
      const u = await routeException(db, op, 'RETURNED_PAYMENT', 'The payment was returned by the provider.', clock);
      await patchOp(db, op.id, { opState: 'RETURNED', customerSafeCategory: 'RETURNED' });
      await events.publish(db, { type: 'payout.returned', organizationId: op.organizationId, accountId: op.accountId, payload: { payoutRequestId: op.payoutRequestId } });
      opState = 'RETURNED';
      void u;
      break;
    }
    case 'PAYOUT_CANCELED':
      if (!terminal) {
        const u = await patchOp(db, op.id, { opState: 'CANCELED', customerSafeCategory: 'UNDER_REVIEW' });
        opState = u.opState as OpState;
      }
      break;
    case 'PAYOUT_UNKNOWN':
      break;
  }
  await db.update(payoutProviderEvents).set({ processingState: 'PROCESSED', payoutRequestId: op.payoutRequestId }).where(eq(payoutProviderEvents.id, inserted.id));
  return { deduped: false, opState };
}

/** Mark a payout FAILED at the economic layer (post-submission provider failure). */
async function failPayout(db: Database, payoutRequestId: string): Promise<void> {
  const [request] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, payoutRequestId));
  if (!request) return;
  if (request.state === 'APPROVED' || request.state === 'PROCESSING') {
    await db.update(payoutRequests).set({ state: 'FAILED', version: request.version + 1, updatedAt: new Date() }).where(eq(payoutRequests.id, payoutRequestId));
    const [account] = await db.select().from(accounts).where(eq(accounts.id, request.accountId));
    await recordAudit(db, { organizationId: request.organizationId, actor: SYSTEM_ACTOR, subjectType: 'ACCOUNT', subjectId: request.accountId, accountId: request.accountId, userId: account?.userId, action: 'payout.failed', prevState: { state: request.state }, newState: { state: 'FAILED' } });
    await events.publish(db, { type: 'payout.failed', organizationId: request.organizationId, accountId: request.accountId, payload: { payoutRequestId } });
  }
}

// -- reconciliation ----------------------------------------------------------

export type ReconcileTrigger = 'POST_SUBMIT' | 'PERIODIC' | 'MANUAL' | 'WEBHOOK';

/**
 * Compare the expected local state against the provider-authoritative state.
 * Safe deterministic transitions reconcile automatically (provider ahead → apply);
 * ambiguous or dangerous mismatches are recorded and routed to exception review.
 */
export async function reconcilePayout(db: Database, payoutRequestId: string, opts: { trigger: ReconcileTrigger; clock?: Clock }): Promise<{ mismatchType: string; autoResolved: boolean }> {
  const clock = opts.clock ?? systemClock;
  const op = await getOperationByRequest(db, payoutRequestId);
  if (!op) return { mismatchType: 'NONE', autoResolved: false };
  const provider = resolvePayoutProvider(op.provider);
  const got = await provider.reconcile({ idempotencyKey: op.idempotencyKey, providerPayoutId: op.providerPayoutId ?? undefined });

  let mismatchType = 'NONE';
  let autoResolved = false;

  if (!got.found) {
    if (['SUBMITTED', 'PROCESSING'].includes(op.opState)) mismatchType = 'MISSING_PROVIDER_REF';
  } else {
    // Provider ahead: PAID upstream while we still show submitted/processing.
    if (got.status === 'PAID' && op.opState !== 'PAID' && op.opState !== 'RECONCILED') {
      await applyProviderPaid(db, payoutRequestId, { providerPayoutId: got.providerPayoutId, amountMicros: got.amountMicros, clock });
      mismatchType = 'PROVIDER_AHEAD'; autoResolved = true;
    } else if (got.status === 'RETURNED' && op.opState === 'PAID') {
      mismatchType = 'LOCAL_AHEAD';
      await routeException(db, op, 'RETURNED_PAYMENT', 'Provider reports the payment was returned.', clock);
    } else if (got.status === 'PROCESSING' && op.opState === 'SUBMITTED') {
      await patchOp(db, op.id, { opState: 'PROCESSING', providerProcessingAt: op.providerProcessingAt ?? clock.date(), customerSafeCategory: 'PROCESSING' });
      mismatchType = 'NONE'; autoResolved = true;
    }
    // Amount mismatch on a paid payout is serious but must not un-pay.
    const [request] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, payoutRequestId));
    if (got.amountMicros != null && request?.traderShareMicros != null && got.amountMicros !== request.traderShareMicros) {
      mismatchType = 'AMOUNT_MISMATCH';
      if (op.customerIdentityId) await emitSignalSafe(db, op.organizationId, op.customerIdentityId, op.accountId, 'PAYOUT_AMOUNT_MISMATCH');
    }
  }

  await recordReconciliation(db, op, mismatchType, got.found ? got.status : null, autoResolved, { trigger: opts.trigger });
  await patchOp(db, op.id, { reconciledAt: clock.date(), opState: op.opState === 'PAID' && mismatchType === 'NONE' ? 'RECONCILED' : op.opState });
  return { mismatchType, autoResolved };
}
