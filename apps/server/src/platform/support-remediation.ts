/**
 * Controlled remediation workflow (Milestone 12-G).
 *
 * Support REQUESTS remediation; an authorized role APPROVES; the canonical domain
 * service EXECUTES. Support never mutates money or trades directly — every path
 * here calls the same engine an operator would (admin adjustment, canonical reset,
 * commerce refund). Approval and execution are idempotent (advisory lock + status
 * guards) so two approvers or two workers can never double-apply. Everything is
 * audited, and nothing is ever faked green.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { commercialOrders, supportRemediations } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from './actor.js';
import { recordAudit } from './audit.js';
import { generateRemediationRef, type RemediationStatus, type RemediationType } from './support-config.js';
import { getTicketRow } from './support-tickets.js';
import { applyAdminAdjustment, type AdjustmentReasonCode } from './account-ops.js';
import { handleRefund } from './commerce-refund.js';
import { createResetOrder } from './account-reset.js';
import { refundEligibility } from './support-diagnostics.js';

const REM_LOCK_CLASS = 0x53524d44; // 'SRMD'

export interface RequestRemediationInput {
  readonly ticketId: string;
  readonly type: RemediationType;
  readonly reason: string;
  readonly detail?: Record<string, unknown>;
  readonly amountMicros?: number | null;
  readonly idempotencyKey?: string | null;
  readonly actor: Actor;
}

export async function requestRemediation(db: Database, input: RequestRemediationInput): Promise<{ id: string; publicRef: string }> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  if (!input.reason.trim()) throw ApiError.badRequest('REASON_REQUIRED', 'A reason is required.');
  if (!input.actor.userId) throw ApiError.forbidden('A staff identity is required to request remediation.');
  if (input.amountMicros != null && (!Number.isInteger(input.amountMicros) || input.amountMicros <= 0)) {
    throw ApiError.badRequest('INVALID_AMOUNT', 'Amount must be a positive integer (micros).');
  }
  // Idempotent request: a repeat with the same key returns the existing row.
  if (input.idempotencyKey) {
    const [ex] = await db.select().from(supportRemediations).where(eq(supportRemediations.idempotencyKey, input.idempotencyKey));
    if (ex) return { id: ex.id, publicRef: ex.publicRef };
  }
  const publicRef = generateRemediationRef();
  const [row] = await db.insert(supportRemediations).values({
    organizationId: t.organizationId, ticketId: input.ticketId, publicRef, type: input.type, status: 'REQUESTED',
    requestedByUserId: input.actor.userId, reason: input.reason.trim(), detail: (input.detail ?? {}) as never,
    amountMicros: input.amountMicros ?? null, idempotencyKey: input.idempotencyKey ?? `rem-${crypto.randomUUID()}`,
  }).returning();
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_REMEDIATION', subjectId: row!.id, action: 'support.remediation.requested', newState: { type: input.type, ticketId: input.ticketId, amountMicros: input.amountMicros ?? null }, reason: input.reason.trim() });
  return { id: row!.id, publicRef };
}

export async function listRemediations(db: Database, ticketId: string) {
  return db.select().from(supportRemediations).where(eq(supportRemediations.ticketId, ticketId)).orderBy(sql`${supportRemediations.createdAt} desc`);
}
export async function getRemediation(db: Database, id: string) {
  const [r] = await db.select().from(supportRemediations).where(eq(supportRemediations.id, id));
  return r ?? null;
}

export async function approveRemediation(db: Database, input: { remediationId: string; actor: Actor }): Promise<{ status: RemediationStatus }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(${REM_LOCK_CLASS}, hashtext(${input.remediationId}))`);
    const [r] = await tx.select().from(supportRemediations).where(eq(supportRemediations.id, input.remediationId));
    if (!r) throw ApiError.notFound('REMEDIATION_NOT_FOUND', 'Remediation not found.');
    if (r.status === 'APPROVED') return { status: 'APPROVED' }; // idempotent
    if (r.status !== 'REQUESTED' && r.status !== 'UNDER_REVIEW') throw ApiError.badRequest('NOT_APPROVABLE', `Cannot approve a ${r.status} remediation.`);
    // Four-eyes: the approver must not be the requester.
    if (r.requestedByUserId === input.actor.userId) throw ApiError.forbidden('A remediation must be approved by someone other than the requester.');
    await tx.update(supportRemediations).set({ status: 'APPROVED', approvedByUserId: input.actor.userId ?? null, approvedAt: new Date(), version: r.version + 1, updatedAt: new Date() }).where(eq(supportRemediations.id, input.remediationId));
    await recordAudit(tx, { organizationId: r.organizationId, actor: input.actor, subjectType: 'SUPPORT_REMEDIATION', subjectId: r.id, action: 'support.remediation.approved', prevState: { status: r.status }, newState: { status: 'APPROVED' } });
    return { status: 'APPROVED' };
  });
}

export async function denyRemediation(db: Database, input: { remediationId: string; reason: string; actor: Actor }): Promise<void> {
  const r = await getRemediation(db, input.remediationId);
  if (!r) throw ApiError.notFound('REMEDIATION_NOT_FOUND', 'Remediation not found.');
  if (['EXECUTED', 'EXECUTING'].includes(r.status)) throw ApiError.badRequest('ALREADY_EXECUTING', 'Cannot deny a remediation that is executing or executed.');
  await db.update(supportRemediations).set({ status: 'DENIED', deniedReason: input.reason.slice(0, 1000), version: r.version + 1, updatedAt: new Date() }).where(eq(supportRemediations.id, input.remediationId));
  await recordAudit(db, { organizationId: r.organizationId, actor: input.actor, subjectType: 'SUPPORT_REMEDIATION', subjectId: r.id, action: 'support.remediation.denied', prevState: { status: r.status }, newState: { status: 'DENIED' }, reason: input.reason });
}

/**
 * Execute an APPROVED remediation through the canonical domain service. Idempotent:
 * a second call (or a second worker) after EXECUTED is a no-op. On any engine
 * failure the remediation is marked FAILED with the real reason — never faked.
 */
export async function executeRemediation(db: Database, input: { remediationId: string; actor: Actor }): Promise<{ status: RemediationStatus; executionRef?: string | null; failureReason?: string | null }> {
  // Claim the row (APPROVED → EXECUTING) atomically so only one worker proceeds.
  const claimed = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(${REM_LOCK_CLASS}, hashtext(${input.remediationId}))`);
    const [r] = await tx.select().from(supportRemediations).where(eq(supportRemediations.id, input.remediationId));
    if (!r) throw ApiError.notFound('REMEDIATION_NOT_FOUND', 'Remediation not found.');
    if (r.status === 'EXECUTED') return { done: true as const, r };
    if (r.status !== 'APPROVED') throw ApiError.badRequest('NOT_APPROVED', `Cannot execute a ${r.status} remediation.`);
    await tx.update(supportRemediations).set({ status: 'EXECUTING', version: r.version + 1, updatedAt: new Date() }).where(eq(supportRemediations.id, input.remediationId));
    return { done: false as const, r };
  });
  if (claimed.done) return { status: 'EXECUTED', executionRef: claimed.r.executionRef };

  const r = claimed.r;
  const t = await getTicketRow(db, r.ticketId);
  const detail = (r.detail ?? {}) as Record<string, unknown>;
  try {
    let executionRef = 'MANUAL_ACTION_REQUIRED';
    switch (r.type) {
      case 'ACCOUNT_ADJUSTMENT': {
        const accountId = String(detail['accountId'] ?? '');
        const direction = String(detail['direction'] ?? 'CREDIT') as 'CREDIT' | 'DEBIT';
        if (!accountId) throw new Error('accountId required for an account adjustment');
        if (r.amountMicros == null || r.amountMicros <= 0) throw new Error('a positive amount is required');
        const res = await applyAdminAdjustment(db, { organizationId: r.organizationId, accountId, type: direction, amountMicros: r.amountMicros, reasonCode: (String(detail['reasonCode'] ?? 'GOODWILL') as AdjustmentReasonCode), explanation: r.reason, linkedIncidentId: (t?.incidentId ?? null), actor: input.actor });
        executionRef = `adjustment:${res.id}`;
        break;
      }
      case 'COURTESY_RESET':
      case 'TECHNICAL_RESET': {
        const failedAccountId = String(detail['accountId'] ?? detail['failedAccountId'] ?? '');
        if (!failedAccountId) throw new Error('accountId (the failed account) is required for a reset');
        const userId = t?.customerUserId;
        if (!userId) throw new Error('ticket customer not found');
        const reset = await createResetOrder(db, { organizationId: r.organizationId, userId, failedAccountId, actor: input.actor });
        executionRef = `reset_order:${reset.orderId}`;
        break;
      }
      case 'REFUND': {
        const orderId = String(detail['orderId'] ?? '');
        if (!orderId) throw new Error('orderId required for a refund');
        const isException = detail['exception'] === true;
        if (!isException) {
          const elig = await refundEligibility(db, r.organizationId, orderId);
          if (!elig.eligible) throw new Error(`ordinary refund not eligible: ${elig.reason}`);
        }
        const [order] = await db.select().from(commercialOrders).where(and(eq(commercialOrders.id, orderId), eq(commercialOrders.organizationId, r.organizationId)));
        if (!order) throw new Error('order not found');
        await handleRefund(db, { order, reason: `support remediation ${r.publicRef}: ${r.reason}`, actor: input.actor });
        // Internal state recorded; any EXTERNAL settlement is a separate provider/manual step (never faked).
        executionRef = `refund:${orderId}:INTERNAL_RECORDED`;
        break;
      }
      // Controlled types with no safe automatic executor: recorded + approved, but
      // the sensitive action is performed by the authorized role in its own console.
      case 'TRADING_REMEDIATION':
      case 'PURCHASE_CORRECTION':
      case 'PAYOUT_CORRECTION':
      case 'CERTIFICATE_CORRECTION':
      case 'ACCESS_RESTORATION':
      case 'OTHER':
      default:
        executionRef = 'MANUAL_ACTION_REQUIRED';
        break;
    }
    await db.update(supportRemediations).set({ status: 'EXECUTED', executedAt: new Date(), executionRef, version: r.version + 2, updatedAt: new Date() }).where(eq(supportRemediations.id, input.remediationId));
    await recordAudit(db, { organizationId: r.organizationId, actor: input.actor, subjectType: 'SUPPORT_REMEDIATION', subjectId: r.id, action: 'support.remediation.executed', newState: { type: r.type, executionRef } });
    return { status: 'EXECUTED', executionRef };
  } catch (e) {
    const failureReason = (e as Error).message.slice(0, 500);
    await db.update(supportRemediations).set({ status: 'FAILED', failureReason, version: r.version + 2, updatedAt: new Date() }).where(eq(supportRemediations.id, input.remediationId));
    await recordAudit(db, { organizationId: r.organizationId, actor: input.actor, subjectType: 'SUPPORT_REMEDIATION', subjectId: r.id, action: 'support.remediation.failed', newState: { failureReason } });
    return { status: 'FAILED', failureReason };
  }
}
