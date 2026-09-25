/**
 * Account operations for the Owner OS (M10-E).
 *
 * Safety first (§2, §27): there is NO raw balance edit. A financial correction is
 * an APPEND-ONLY `admin_adjustments` record with a reason code, an explanation,
 * a before/after projection snapshot and an audit event — it never rewrites
 * historical executions and never silently mutates the engine's derived balance.
 * Lifecycle operations (pause/resume/disable/enable/reset) delegate to the
 * authoritative `account-service` transitions (which already audit + emit
 * events); this module adds preview, reason-coding, and the adjustment ledger.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accountProjections, accounts, adminAdjustments } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from './actor.js';
import { recordAudit } from './audit.js';
import { lockAccount, unlockAccount, disableAccount, enableAccount } from './account-service.js';
import { resetQuote } from './account-reset.js';

export const ADJUSTMENT_REASON_CODES = [
  'INCIDENT_REMEDIATION',
  'GOODWILL_CREDIT',
  'FEE_CORRECTION',
  'DATA_CORRECTION',
  'DUPLICATE_CHARGE_REMEDIATION',
  'OTHER',
] as const;
export type AdjustmentReasonCode = (typeof ADJUSTMENT_REASON_CODES)[number];

async function projectionBalance(db: Database, accountId: string): Promise<number | null> {
  const [p] = await db.select({ balanceMicros: accountProjections.balanceMicros }).from(accountProjections).where(eq(accountProjections.accountId, accountId));
  if (p) return p.balanceMicros;
  const [a] = await db.select({ balanceMicros: accounts.balanceMicros }).from(accounts).where(eq(accounts.id, accountId));
  return a?.balanceMicros ?? null;
}

/** The net of recorded admin adjustments for an account (observational). */
export async function adjustmentNetMicros(db: Database, accountId: string): Promise<number> {
  const [row] = await db
    .select({ net: sql<number>`coalesce(sum(case when ${adminAdjustments.type} = 'DEBIT' then -${adminAdjustments.amountMicros} else ${adminAdjustments.amountMicros} end), 0)::bigint` })
    .from(adminAdjustments)
    .where(eq(adminAdjustments.accountId, accountId));
  return Number(row?.net ?? 0);
}

export interface AdjustmentInput {
  readonly organizationId: string | null;
  readonly accountId: string;
  readonly type: 'CREDIT' | 'DEBIT' | 'METADATA';
  readonly amountMicros?: number | null;
  readonly reasonCode: AdjustmentReasonCode;
  readonly explanation: string;
  readonly linkedIncidentId?: string | null;
  readonly linkedCaseId?: string | null;
  readonly actor: Actor;
}

/**
 * Record a financial/metadata correction. Append-only; the DB trigger refuses
 * UPDATE/DELETE. A CREDIT/DEBIT requires a positive amount; METADATA carries
 * none. The row snapshots the projection balance before/after (after is derived
 * from the recorded adjustment net, not a rewritten projection).
 */
export async function applyAdminAdjustment(db: Database, input: AdjustmentInput): Promise<{ id: string }> {
  if (!input.explanation || input.explanation.trim().length < 5) {
    throw ApiError.badRequest('EXPLANATION_REQUIRED', 'A written explanation is required.');
  }
  if ((input.type === 'CREDIT' || input.type === 'DEBIT')) {
    if (input.amountMicros == null || !Number.isFinite(input.amountMicros) || input.amountMicros <= 0) {
      throw ApiError.badRequest('AMOUNT_REQUIRED', 'A positive amount is required for a credit or debit.');
    }
  }
  const [acct] = await db.select({ id: accounts.id, organizationId: accounts.organizationId, userId: accounts.userId }).from(accounts).where(eq(accounts.id, input.accountId));
  if (!acct) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'Account not found.');
  const beforeBalance = await projectionBalance(db, input.accountId);
  const beforeNet = await adjustmentNetMicros(db, input.accountId);
  const delta = input.type === 'METADATA' ? 0 : input.type === 'DEBIT' ? -(input.amountMicros ?? 0) : input.amountMicros ?? 0;
  const before = { projectionBalanceMicros: beforeBalance, adjustmentNetMicros: beforeNet };
  const after = { projectionBalanceMicros: beforeBalance, adjustmentNetMicros: beforeNet + delta };
  const [row] = await db
    .insert(adminAdjustments)
    .values({
      organizationId: input.organizationId ?? acct.organizationId,
      accountId: input.accountId,
      userId: acct.userId,
      type: input.type,
      amountMicros: input.type === 'METADATA' ? null : input.amountMicros ?? null,
      reasonCode: input.reasonCode,
      explanation: input.explanation.trim(),
      beforeSnapshot: before as never,
      afterSnapshot: after as never,
      linkedIncidentId: input.linkedIncidentId ?? null,
      linkedCaseId: input.linkedCaseId ?? null,
      actorUserId: input.actor.userId ?? null,
    })
    .returning({ id: adminAdjustments.id });
  await recordAudit(db, {
    organizationId: input.organizationId ?? acct.organizationId,
    actor: input.actor,
    subjectType: 'ACCOUNT',
    subjectId: input.accountId,
    accountId: input.accountId,
    action: 'admin.account.adjustment',
    prevState: before,
    newState: { ...after, type: input.type, reasonCode: input.reasonCode },
    reason: input.explanation.trim(),
  });
  return { id: row!.id };
}

export async function listAdjustments(db: Database, accountId: string) {
  return db
    .select()
    .from(adminAdjustments)
    .where(eq(adminAdjustments.accountId, accountId))
    .orderBy(desc(adminAdjustments.createdAt))
    .limit(200);
}

// ---------------------------------------------------------------------------
// Action preview (§30)
// ---------------------------------------------------------------------------

export interface ActionPreview {
  readonly action: string;
  readonly will: string[];
  readonly willNot: string[];
  readonly paymentRequired: boolean;
  readonly priceMicros?: number | null;
  readonly blocked?: string | null;
}

export async function previewAction(db: Database, accountId: string, action: string, userId?: string): Promise<ActionPreview> {
  const [acct] = await db.select({ id: accounts.id, status: accounts.status, publicId: accounts.publicId, userId: accounts.userId }).from(accounts).where(eq(accounts.id, accountId));
  if (!acct) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'Account not found.');
  switch (action) {
    case 'pause':
      return { action, will: ['Set an operator hold (LOCKED)', 'Stop new/increasing trading', 'Preserve risk-reducing actions (cancel/flatten/reduce)'], willNot: ['Close open positions', 'End the account', 'Alter balance or history'], paymentRequired: false };
    case 'resume':
      return { action, will: ['Clear the operator hold', 'Restore the rule-engine status'], willNot: ['Reactivate a failed account', 'Alter balance or history'], paymentRequired: false };
    case 'disable':
      return { action, will: ['Disable the account', 'Cancel working orders'], willNot: ['Delete history', 'Alter prior payouts'], paymentRequired: false };
    case 'reset': {
      // The real, server-authoritative reset quote (original product-version price).
      try {
        const quote = await resetQuote(db, userId ?? acct.userId, accountId);
        return {
          action,
          will: ['Preserve the failed account and its history', 'Preserve executions, payouts and enforcement', 'Create a replacement lifecycle on the SAME product version', 'Consume an active-account slot on success'],
          willNot: ['Delete trading history', 'Alter prior payouts', 'Alter customer identity'],
          paymentRequired: (quote.priceMicros ?? 0) > 0,
          priceMicros: quote.priceMicros ?? null,
        };
      } catch (e) {
        return { action, will: [], willNot: [], paymentRequired: false, blocked: (e as Error).message };
      }
    }
    default:
      throw ApiError.badRequest('UNKNOWN_ACTION', `Unknown action ${action}.`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle wrappers (delegate to authoritative account-service)
// ---------------------------------------------------------------------------

export async function pauseAccount(db: Database, accountId: string, reason: string, actor: Actor) {
  if (!reason || reason.trim().length < 3) throw ApiError.badRequest('REASON_REQUIRED', 'A reason is required to pause an account.');
  return lockAccount(db, accountId, actor, reason.trim());
}
export async function resumeAccount(db: Database, accountId: string, reason: string, actor: Actor) {
  return unlockAccount(db, accountId, actor, reason?.trim() || undefined);
}
export async function disableAccountOp(db: Database, accountId: string, reason: string, actor: Actor) {
  if (!reason || reason.trim().length < 3) throw ApiError.badRequest('REASON_REQUIRED', 'A reason is required to disable an account.');
  return disableAccount(db, accountId, actor, reason.trim());
}
export async function enableAccountOp(db: Database, accountId: string, reason: string, actor: Actor) {
  return enableAccount(db, accountId, actor, reason?.trim() || undefined);
}
