/**
 * Enforcement service (Milestone 7). Server-authoritative case management, signal
 * ingestion, evidence, holds, findings, actions, information requests and appeals.
 *
 * Follows the house pattern: mutate under an identity advisory lock in a
 * transaction, write append-only `recordAudit`, and `events.publish` a domain
 * event that the notification consumer turns into a customer-safe notice. Holds
 * are read by the hot paths via `enforcement-holds.ts`.
 *
 * Principles enforced in code: a signal is not a finding (ingesting a signal never
 * records a finding); a temporary hold is not a conviction (containment holds do
 * not set CONFIRMED_VIOLATION); a rule breach is not misconduct (recordFinding
 * rejects non-misconduct codes); punitive/terminal actions require authority
 * (checked at the route layer); appeals preserve original decisions immutably.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accounts, customerIdentities, enforcementActions, enforcementAppealDecisions, enforcementAppeals,
  enforcementCases, enforcementEvidence, enforcementFindings, enforcementHolds,
  enforcementInformationRequests, enforcementNotes, enforcementSignals,
} from '../db/schema.js';
import { type Actor, SYSTEM_ACTOR } from './actor.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { identityAdvisoryLockSql } from './identity-lock.js';
import {
  type ActionType, type CaseCategory, type CaseSeverity, type CaseStatus, type FindingReasonCode,
  type HoldCapability, type HoldScope, type SignalSource, canTransitionCase, customerSafeCategory,
  customerSafeMessage, deriveSeverity, isAdverseFinding, isMisconductCode, maxSeverity,
} from './enforcement-core.js';

export class EnforcementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'EnforcementError';
  }
}

export type CaseRow = typeof enforcementCases.$inferSelect;
export type HoldRow = typeof enforcementHolds.$inferSelect;
export type SignalRow = typeof enforcementSignals.$inferSelect;
export type FindingRow = typeof enforcementFindings.$inferSelect;
export type AppealRow = typeof enforcementAppeals.$inferSelect;

function idem(): string {
  return randomBytes(18).toString('base64url');
}

function makePublicRef(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = randomBytes(6);
  for (let i = 0; i < 6; i += 1) s += alphabet[b[i]! % alphabet.length];
  return `HTR-${s}`;
}

/** The customer identity id for an auth user, or null. */
export async function identityIdForUser(db: Database, userId: string): Promise<string | null> {
  const [row] = await db.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, userId));
  return row?.id ?? null;
}

// ---- signals ----------------------------------------------------------------

export interface IngestSignalInput {
  organizationId: string;
  source: SignalSource;
  kind: string;
  dedupeKey: string;
  customerIdentityId?: string | null;
  accountId?: string | null;
  severity?: CaseSeverity;
  sourceRef?: string | null;
  metadata?: Record<string, unknown> | null;
  /** When true and the signal warrants it, correlate/open a case. Default false. */
  openCaseCategory?: CaseCategory | null;
  actor?: Actor;
}

/**
 * Ingest a signal idempotently. A signal is NEVER a violation. A case is opened
 * only when `openCaseCategory` is given AND the derived severity is MEDIUM+ or the
 * source is a customer report — low-level signals (new device, IP change) never
 * auto-open a case.
 */
export async function ingestSignal(db: Database, input: IngestSignalInput): Promise<{ signal: SignalRow; caseId: string | null; deduped: boolean }> {
  const severity = input.severity ?? deriveSeverity(input.openCaseCategory ?? 'GENERAL', input.kind);
  const [inserted] = await db
    .insert(enforcementSignals)
    .values({
      organizationId: input.organizationId,
      source: input.source,
      kind: input.kind,
      severity,
      customerIdentityId: input.customerIdentityId ?? null,
      accountId: input.accountId ?? null,
      sourceRef: input.sourceRef ?? null,
      metadata: (input.metadata ?? null) as never,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({ target: [enforcementSignals.organizationId, enforcementSignals.dedupeKey] })
    .returning();

  if (!inserted) {
    const [existing] = await db
      .select()
      .from(enforcementSignals)
      .where(and(eq(enforcementSignals.organizationId, input.organizationId), eq(enforcementSignals.dedupeKey, input.dedupeKey)));
    return { signal: existing!, caseId: existing?.caseId ?? null, deduped: true };
  }

  await events.publish(db, {
    type: 'enforcement.signal_ingested',
    organizationId: input.organizationId,
    payload: { signalId: inserted.id, kind: input.kind, severity },
  });

  // Decide whether to correlate/open a case. Never for low-severity infos.
  let caseId: string | null = null;
  const warrants = input.openCaseCategory != null
    && (input.source === 'CUSTOMER_REPORT' || severity === 'MEDIUM' || severity === 'HIGH' || severity === 'CRITICAL');
  if (warrants && input.customerIdentityId) {
    const category = input.openCaseCategory!;
    const opened = await openCase(db, {
      organizationId: input.organizationId,
      customerIdentityId: input.customerIdentityId,
      accountId: input.accountId ?? null,
      category,
      reasonCode: input.kind,
      severity,
      correlationKey: `${category}:${input.customerIdentityId}`,
      actor: input.actor ?? SYSTEM_ACTOR,
    });
    caseId = opened.id;
    await db.update(enforcementSignals).set({ caseId }).where(eq(enforcementSignals.id, inserted.id));
  }
  return { signal: inserted, caseId, deduped: false };
}

// ---- cases ------------------------------------------------------------------

export interface OpenCaseInput {
  organizationId: string;
  customerIdentityId: string;
  category: CaseCategory;
  accountId?: string | null;
  reasonCode?: string | null;
  severity?: CaseSeverity;
  correlationKey?: string | null;
  actor?: Actor;
}

/**
 * Open a case, or return the existing correlated OPEN/active case. Correlation is
 * deterministic (by correlationKey), so a repeated provider event folds into one
 * case rather than spawning duplicates.
 */
export async function openCase(db: Database, input: OpenCaseInput): Promise<CaseRow> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  return db.transaction(async (tx) => {
    await tx.execute(identityAdvisoryLockSql(input.customerIdentityId));
    if (input.correlationKey) {
      const [existing] = await tx
        .select()
        .from(enforcementCases)
        .where(and(
          eq(enforcementCases.organizationId, input.organizationId),
          eq(enforcementCases.correlationKey, input.correlationKey),
          inArray(enforcementCases.status, ['OPEN', 'TRIAGED', 'UNDER_REVIEW', 'AWAITING_CUSTOMER', 'ESCALATED']),
        ))
        .orderBy(desc(enforcementCases.openedAt));
      if (existing) {
        // Fold in: raise severity if the new signal is more urgent.
        const sev = maxSeverity(existing.severity as CaseSeverity, input.severity ?? 'LOW');
        if (sev !== existing.severity) {
          await tx.update(enforcementCases).set({ severity: sev, updatedAt: new Date() }).where(eq(enforcementCases.id, existing.id));
        }
        return existing;
      }
    }
    let publicRef = makePublicRef();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const dupe = await tx.select({ id: enforcementCases.id }).from(enforcementCases)
        .where(and(eq(enforcementCases.organizationId, input.organizationId), eq(enforcementCases.publicRef, publicRef)));
      if (dupe.length === 0) break;
      publicRef = makePublicRef();
    }
    const [row] = await tx.insert(enforcementCases).values({
      organizationId: input.organizationId,
      customerIdentityId: input.customerIdentityId,
      subjectAccountId: input.accountId ?? null,
      category: input.category,
      severity: input.severity ?? 'LOW',
      status: 'OPEN',
      customerSafeCategory: customerSafeCategory(input.category),
      reasonCode: input.reasonCode ?? null,
      correlationKey: input.correlationKey ?? null,
      publicRef,
    }).returning();
    await recordAudit(tx, {
      organizationId: input.organizationId, actor, subjectType: 'ENFORCEMENT', subjectId: row!.id,
      userId: undefined, action: 'enforcement.case_opened',
      newState: { category: input.category, severity: row!.severity, publicRef },
      reason: input.reasonCode ?? null,
    });
    await events.publish(tx, {
      type: 'enforcement.case_opened', organizationId: input.organizationId,
      payload: { caseId: row!.id, customerIdentityId: input.customerIdentityId, category: input.category, customerSafeCategory: row!.customerSafeCategory },
    });
    return row!;
  });
}

export async function getCase(db: Database, caseId: string): Promise<CaseRow | null> {
  const [row] = await db.select().from(enforcementCases).where(eq(enforcementCases.id, caseId));
  return row ?? null;
}

export interface TransitionInput { caseId: string; to: CaseStatus; actor: Actor; reason?: string | null; expectedVersion?: number }

export async function transitionCase(db: Database, input: TransitionInput): Promise<CaseRow> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(enforcementCases).where(eq(enforcementCases.id, input.caseId));
    if (!c) throw new EnforcementError('CASE_NOT_FOUND', 'Case not found.');
    await tx.execute(identityAdvisoryLockSql(c.customerIdentityId));
    if (input.expectedVersion != null && input.expectedVersion !== c.version) {
      throw new EnforcementError('VERSION_CONFLICT', 'The case changed since you loaded it.');
    }
    if (!canTransitionCase(c.status as CaseStatus, input.to)) {
      throw new EnforcementError('INVALID_TRANSITION', `Cannot move a case from ${c.status} to ${input.to}.`);
    }
    const [row] = await tx.update(enforcementCases)
      .set({ status: input.to, version: c.version + 1, updatedAt: new Date(), closedAt: ['RESOLVED_NO_ACTION', 'RESOLVED_REMEDIATED', 'OVERTURNED', 'FINALIZED'].includes(input.to) ? new Date() : c.closedAt })
      .where(and(eq(enforcementCases.id, c.id), eq(enforcementCases.version, c.version)))
      .returning();
    if (!row) throw new EnforcementError('VERSION_CONFLICT', 'Concurrent update; retry.');
    await recordAudit(tx, { organizationId: c.organizationId, actor: input.actor, subjectType: 'ENFORCEMENT', subjectId: c.id, action: 'enforcement.case_transition', prevState: { status: c.status }, newState: { status: input.to }, reason: input.reason ?? null });
    await events.publish(tx, { type: 'enforcement.case_updated', organizationId: c.organizationId, payload: { caseId: c.id, status: input.to } });
    return row;
  });
}

export async function assignCase(db: Database, caseId: string, assigneeUserId: string | null, actor: Actor): Promise<CaseRow> {
  const [c] = await db.select().from(enforcementCases).where(eq(enforcementCases.id, caseId));
  if (!c) throw new EnforcementError('CASE_NOT_FOUND', 'Case not found.');
  const [row] = await db.update(enforcementCases).set({ assignedToUserId: assigneeUserId, updatedAt: new Date(), status: c.status === 'OPEN' ? 'TRIAGED' : c.status }).where(eq(enforcementCases.id, caseId)).returning();
  await recordAudit(db, { organizationId: c.organizationId, actor, subjectType: 'ENFORCEMENT', subjectId: caseId, action: 'enforcement.case_assigned', newState: { assignedToUserId: assigneeUserId }, reason: null });
  return row!;
}

export async function addNote(db: Database, input: { caseId: string; authorUserId: string; body: string; visibility?: string; actor: Actor }): Promise<void> {
  const [c] = await db.select().from(enforcementCases).where(eq(enforcementCases.id, input.caseId));
  if (!c) throw new EnforcementError('CASE_NOT_FOUND', 'Case not found.');
  await db.insert(enforcementNotes).values({ organizationId: c.organizationId, caseId: input.caseId, authorUserId: input.authorUserId, body: input.body.slice(0, 8000), visibility: input.visibility === 'CUSTOMER_SAFE' ? 'CUSTOMER_SAFE' : 'INTERNAL' });
  await recordAudit(db, { organizationId: c.organizationId, actor: input.actor, subjectType: 'ENFORCEMENT', subjectId: input.caseId, action: 'enforcement.note_added', reason: null });
}

export async function addEvidence(db: Database, input: { caseId: string; type: string; source: SignalSource | string; sourceRef?: string | null; visibility?: string; metadata?: Record<string, unknown> | null; integrityHash?: string | null; createdByUserId?: string | null; createdBySystem?: boolean; actor: Actor }): Promise<string> {
  const [c] = await db.select().from(enforcementCases).where(eq(enforcementCases.id, input.caseId));
  if (!c) throw new EnforcementError('CASE_NOT_FOUND', 'Case not found.');
  const visibility = ['INTERNAL', 'CUSTOMER_SAFE', 'LEGAL_RESTRICTED'].includes(input.visibility ?? '') ? input.visibility! : 'INTERNAL';
  const [row] = await db.insert(enforcementEvidence).values({
    organizationId: c.organizationId, caseId: input.caseId, type: input.type.slice(0, 40), source: String(input.source).slice(0, 24),
    sourceRef: input.sourceRef ?? null, visibility, metadata: (input.metadata ?? null) as never, integrityHash: input.integrityHash ?? null,
    createdByUserId: input.createdByUserId ?? null, createdBySystem: input.createdBySystem ?? false,
  }).returning();
  await recordAudit(db, { organizationId: c.organizationId, actor: input.actor, subjectType: 'ENFORCEMENT', subjectId: input.caseId, action: 'enforcement.evidence_added', newState: { evidenceId: row!.id, type: input.type, visibility }, reason: null });
  return row!.id;
}

// ---- holds ------------------------------------------------------------------

export interface PlaceHoldInput {
  organizationId: string;
  caseId?: string | null;
  scope: HoldScope;
  scopeId: string;
  capability: HoldCapability;
  reasonCode: string;
  customerSafeCategory?: string;
  expiresAt?: Date | null;
  createdByUserId?: string | null;
  createdBySystem?: boolean;
  idempotencyKey?: string;
  actor?: Actor;
}

/** Place a hold, idempotent on (org, idempotencyKey). Returns the hold row. */
export async function placeHold(db: Database, input: PlaceHoldInput): Promise<HoldRow> {
  const key = input.idempotencyKey ?? idem();
  const [inserted] = await db.insert(enforcementHolds).values({
    organizationId: input.organizationId, caseId: input.caseId ?? null, scope: input.scope, scopeId: input.scopeId,
    capability: input.capability, reasonCode: input.reasonCode, customerSafeCategory: input.customerSafeCategory ?? 'GENERAL_REVIEW',
    createdByUserId: input.createdByUserId ?? null, createdBySystem: input.createdBySystem ?? false, expiresAt: input.expiresAt ?? null,
    idempotencyKey: key,
  }).onConflictDoNothing({ target: [enforcementHolds.organizationId, enforcementHolds.idempotencyKey] }).returning();
  if (!inserted) {
    const [existing] = await db.select().from(enforcementHolds).where(and(eq(enforcementHolds.organizationId, input.organizationId), eq(enforcementHolds.idempotencyKey, key)));
    return existing!;
  }
  await recordAudit(db, { organizationId: input.organizationId, actor: input.actor ?? SYSTEM_ACTOR, subjectType: 'ENFORCEMENT', subjectId: input.caseId ?? inserted.id, action: 'enforcement.hold_placed', newState: { holdId: inserted.id, scope: input.scope, scopeId: input.scopeId, capability: input.capability, reasonCode: input.reasonCode }, reason: input.reasonCode });
  await events.publish(db, { type: 'enforcement.hold_placed', organizationId: input.organizationId, payload: { holdId: inserted.id, caseId: input.caseId ?? null, scope: input.scope, capability: input.capability } });
  return inserted;
}

export async function releaseHold(db: Database, holdId: string, opts: { actor: Actor; reason?: string | null; releasedByUserId?: string | null }): Promise<HoldRow | null> {
  const [h] = await db.select().from(enforcementHolds).where(eq(enforcementHolds.id, holdId));
  if (!h) throw new EnforcementError('HOLD_NOT_FOUND', 'Hold not found.');
  if (h.status !== 'ACTIVE') return h; // idempotent
  const [row] = await db.update(enforcementHolds)
    .set({ status: 'RELEASED', releasedAt: new Date(), releasedByUserId: opts.releasedByUserId ?? null, releaseReason: (opts.reason ?? null)?.slice(0, 200) ?? null, version: h.version + 1 })
    .where(and(eq(enforcementHolds.id, holdId), eq(enforcementHolds.status, 'ACTIVE'))).returning();
  await recordAudit(db, { organizationId: h.organizationId, actor: opts.actor, subjectType: 'ENFORCEMENT', subjectId: h.caseId ?? holdId, action: 'enforcement.hold_released', prevState: { status: 'ACTIVE' }, newState: { status: 'RELEASED' }, reason: opts.reason ?? null });
  await events.publish(db, { type: 'enforcement.hold_released', organizationId: h.organizationId, payload: { holdId, caseId: h.caseId ?? null } });
  return row ?? h;
}

/** Release every ACTIVE hold attached to a case (used on no-action / overturn). */
export async function releaseCaseHolds(db: Database, caseId: string, actor: Actor, reason: string): Promise<number> {
  const active = await db.select().from(enforcementHolds).where(and(eq(enforcementHolds.caseId, caseId), eq(enforcementHolds.status, 'ACTIVE')));
  for (const h of active) await releaseHold(db, h.id, { actor, reason });
  return active.length;
}

// ---- findings & actions -----------------------------------------------------

export interface RecordFindingInput {
  organizationId: string;
  caseId: string;
  reasonCode: FindingReasonCode;
  summarySafe?: string | null;
  rationaleInternal?: string | null;
  decidedByUserId: string;
  appealable?: boolean;
  actor: Actor;
}

/**
 * Record an evidence-supported finding. NO_VIOLATION resolves the case with no
 * action and releases its temporary holds. An adverse finding moves the case to
 * CONFIRMED_VIOLATION and marks it appealable. Rule-breach codes are rejected —
 * a rule breach is never an enforcement finding.
 */
export async function recordFinding(db: Database, input: RecordFindingInput): Promise<FindingRow> {
  if (!isAdverseFinding(input.reasonCode) && input.reasonCode !== 'NO_VIOLATION') {
    throw new EnforcementError('INVALID_FINDING', `Unknown finding code ${input.reasonCode}.`);
  }
  if (input.reasonCode !== 'NO_VIOLATION' && !isMisconductCode(input.reasonCode)) {
    throw new EnforcementError('NOT_MISCONDUCT', 'A rule breach or non-misconduct code cannot be recorded as a finding.');
  }
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(enforcementCases).where(eq(enforcementCases.id, input.caseId));
    if (!c) throw new EnforcementError('CASE_NOT_FOUND', 'Case not found.');
    await tx.execute(identityAdvisoryLockSql(c.customerIdentityId));
    const adverse = input.reasonCode !== 'NO_VIOLATION';
    const [finding] = await tx.insert(enforcementFindings).values({
      organizationId: c.organizationId, caseId: input.caseId, reasonCode: input.reasonCode, adverse,
      appealable: adverse ? (input.appealable ?? true) : false, summarySafe: input.summarySafe ?? null,
      rationaleInternal: input.rationaleInternal ?? null, decidedByUserId: input.decidedByUserId, status: 'ACTIVE',
    }).returning();
    const nextStatus: CaseStatus = adverse ? 'CONFIRMED_VIOLATION' : 'RESOLVED_NO_ACTION';
    await tx.update(enforcementCases).set({ status: nextStatus, version: c.version + 1, updatedAt: new Date(), closedAt: adverse ? c.closedAt : new Date() }).where(eq(enforcementCases.id, c.id));
    if (!adverse) {
      // False-positive path: remove temporary holds, restore capability.
      const active = await tx.select().from(enforcementHolds).where(and(eq(enforcementHolds.caseId, c.id), eq(enforcementHolds.status, 'ACTIVE')));
      for (const h of active) {
        await tx.update(enforcementHolds).set({ status: 'RELEASED', releasedAt: new Date(), releaseReason: 'Resolved — no violation', version: h.version + 1 }).where(eq(enforcementHolds.id, h.id));
      }
    }
    await recordAudit(tx, { organizationId: c.organizationId, actor: input.actor, subjectType: 'ENFORCEMENT', subjectId: c.id, userId: input.decidedByUserId, action: 'enforcement.finding_recorded', newState: { findingId: finding!.id, reasonCode: input.reasonCode, adverse }, reason: input.reasonCode });
    await events.publish(tx, { type: 'enforcement.finding_recorded', organizationId: c.organizationId, payload: { caseId: c.id, findingId: finding!.id, reasonCode: input.reasonCode, adverse, customerIdentityId: c.customerIdentityId, customerSafeCategory: c.customerSafeCategory } });
    return finding!;
  });
}

export interface RecordActionInput {
  organizationId: string;
  caseId: string;
  actionType: ActionType;
  reasonCode?: string | null;
  scope?: string | null;
  scopeId?: string | null;
  holdId?: string | null;
  performedByUserId?: string | null;
  performedBySystem?: boolean;
  metadata?: Record<string, unknown> | null;
  idempotencyKey?: string;
  actor: Actor;
}

export async function recordAction(db: Database, input: RecordActionInput): Promise<{ id: string; deduped: boolean }> {
  const key = input.idempotencyKey ?? idem();
  const [inserted] = await db.insert(enforcementActions).values({
    organizationId: input.organizationId, caseId: input.caseId, actionType: input.actionType, reasonCode: input.reasonCode ?? null,
    scope: input.scope ?? null, scopeId: input.scopeId ?? null, holdId: input.holdId ?? null,
    performedByUserId: input.performedByUserId ?? null, performedBySystem: input.performedBySystem ?? false,
    metadata: (input.metadata ?? null) as never, idempotencyKey: key,
  }).onConflictDoNothing({ target: [enforcementActions.organizationId, enforcementActions.idempotencyKey] }).returning();
  if (!inserted) {
    const [existing] = await db.select({ id: enforcementActions.id }).from(enforcementActions).where(and(eq(enforcementActions.organizationId, input.organizationId), eq(enforcementActions.idempotencyKey, key)));
    return { id: existing!.id, deduped: true };
  }
  await recordAudit(db, { organizationId: input.organizationId, actor: input.actor, subjectType: 'ENFORCEMENT', subjectId: input.caseId, action: 'enforcement.action_recorded', newState: { actionType: input.actionType }, reason: input.reasonCode ?? null });
  await events.publish(db, { type: 'enforcement.action_recorded', organizationId: input.organizationId, payload: { caseId: input.caseId, actionType: input.actionType } });
  return { id: inserted.id, deduped: false };
}

// ---- information requests ---------------------------------------------------

export async function createInformationRequest(db: Database, input: { caseId: string; requestType: string; messageSafe: string; dueAt?: Date | null; requestedByUserId: string; actor: Actor }): Promise<string> {
  const [c] = await db.select().from(enforcementCases).where(eq(enforcementCases.id, input.caseId));
  if (!c) throw new EnforcementError('CASE_NOT_FOUND', 'Case not found.');
  const [row] = await db.insert(enforcementInformationRequests).values({
    organizationId: c.organizationId, caseId: input.caseId, customerIdentityId: c.customerIdentityId,
    requestType: input.requestType.slice(0, 48), messageSafe: input.messageSafe.slice(0, 4000), dueAt: input.dueAt ?? null, requestedByUserId: input.requestedByUserId,
  }).returning();
  await db.update(enforcementCases).set({ status: 'AWAITING_CUSTOMER', updatedAt: new Date() }).where(eq(enforcementCases.id, input.caseId));
  await recordAudit(db, { organizationId: c.organizationId, actor: input.actor, subjectType: 'ENFORCEMENT', subjectId: input.caseId, action: 'enforcement.information_requested', newState: { requestId: row!.id, requestType: input.requestType }, reason: null });
  await events.publish(db, { type: 'enforcement.information_requested', organizationId: c.organizationId, payload: { caseId: input.caseId, requestId: row!.id, customerIdentityId: c.customerIdentityId, customerSafeCategory: c.customerSafeCategory } });
  return row!.id;
}

export async function respondToInformationRequest(db: Database, input: { requestId: string; customerIdentityId: string; responseText: string }): Promise<void> {
  const [req] = await db.select().from(enforcementInformationRequests).where(eq(enforcementInformationRequests.id, input.requestId));
  if (!req || req.customerIdentityId !== input.customerIdentityId) throw new EnforcementError('NOT_FOUND', 'Information request not found.');
  if (req.responseStatus !== 'PENDING') throw new EnforcementError('ALREADY_RESPONDED', 'This request has already been answered.');
  await db.update(enforcementInformationRequests).set({ responseStatus: 'RESPONDED', responseText: input.responseText.slice(0, 8000), respondedAt: new Date(), version: req.version + 1, updatedAt: new Date() }).where(eq(enforcementInformationRequests.id, input.requestId));
  await db.update(enforcementCases).set({ status: 'UNDER_REVIEW', updatedAt: new Date() }).where(and(eq(enforcementCases.id, req.caseId), eq(enforcementCases.status, 'AWAITING_CUSTOMER')));
  await recordAudit(db, { organizationId: req.organizationId, actor: SYSTEM_ACTOR, subjectType: 'ENFORCEMENT', subjectId: req.caseId, action: 'enforcement.information_provided', newState: { requestId: req.id }, reason: null });
  await events.publish(db, { type: 'enforcement.information_provided', organizationId: req.organizationId, payload: { caseId: req.caseId, requestId: req.id } });
}

// ---- appeals ----------------------------------------------------------------

export interface AppealEligibility { eligible: boolean; reason?: string; findingId?: string; deciderUserId?: string | null }

/** A case is appealable when it has an ACTIVE adverse+appealable finding and no open appeal. */
export async function appealEligibility(db: Database, caseId: string): Promise<AppealEligibility> {
  const [c] = await db.select().from(enforcementCases).where(eq(enforcementCases.id, caseId));
  if (!c) return { eligible: false, reason: 'CASE_NOT_FOUND' };
  if (c.status !== 'CONFIRMED_VIOLATION' && c.status !== 'FINALIZED') return { eligible: false, reason: 'NO_ADVERSE_DECISION' };
  const [finding] = await db.select().from(enforcementFindings)
    .where(and(eq(enforcementFindings.caseId, caseId), eq(enforcementFindings.status, 'ACTIVE'), eq(enforcementFindings.adverse, true), eq(enforcementFindings.appealable, true)))
    .orderBy(desc(enforcementFindings.decidedAt));
  if (!finding) return { eligible: false, reason: 'NOT_APPEALABLE' };
  const [existing] = await db.select({ id: enforcementAppeals.id }).from(enforcementAppeals).where(eq(enforcementAppeals.caseId, caseId));
  if (existing) return { eligible: false, reason: 'ALREADY_APPEALED' };
  return { eligible: true, findingId: finding.id, deciderUserId: finding.decidedByUserId };
}

export async function submitAppeal(db: Database, input: { caseId: string; customerIdentityId: string; customerStatement: string; actor: Actor }): Promise<AppealRow> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(enforcementCases).where(eq(enforcementCases.id, input.caseId));
    if (!c || c.customerIdentityId !== input.customerIdentityId) throw new EnforcementError('NOT_FOUND', 'Case not found.');
    await tx.execute(identityAdvisoryLockSql(c.customerIdentityId));
    const elig = await appealEligibility(tx, input.caseId);
    if (!elig.eligible) throw new EnforcementError('NOT_ELIGIBLE', `This decision cannot be appealed (${elig.reason}).`);
    const [appeal] = await tx.insert(enforcementAppeals).values({
      organizationId: c.organizationId, caseId: input.caseId, customerIdentityId: input.customerIdentityId,
      originalFindingId: elig.findingId ?? null, originalDeciderUserId: elig.deciderUserId ?? null,
      customerStatement: input.customerStatement.slice(0, 8000), status: 'SUBMITTED',
    }).returning();
    await tx.update(enforcementCases).set({ status: 'APPEALED', version: c.version + 1, updatedAt: new Date() }).where(eq(enforcementCases.id, input.caseId));
    await recordAudit(tx, { organizationId: c.organizationId, actor: input.actor, subjectType: 'APPEAL', subjectId: appeal!.id, action: 'enforcement.appeal_submitted', newState: { appealId: appeal!.id, caseId: input.caseId }, reason: null });
    await events.publish(tx, { type: 'enforcement.appeal_submitted', organizationId: c.organizationId, payload: { appealId: appeal!.id, caseId: input.caseId, customerIdentityId: input.customerIdentityId } });
    return appeal!;
  });
}

export type AppealDecision = 'UPHELD' | 'OVERTURNED' | 'PARTIALLY_REMEDIATED' | 'INFORMATION_REQUESTED';

export interface DecideAppealInput {
  appealId: string;
  decision: AppealDecision;
  decidedByUserId: string;
  rationaleInternal?: string | null;
  customerSafeExplanation?: string | null;
  /** Set when a higher authority explicitly permits the original decider to decide the appeal. */
  overrideSameReviewer?: boolean;
  overrideByUserId?: string | null;
  actor: Actor;
}

/**
 * Decide an appeal. Independence guard: the original decider may not decide a
 * serious appeal unless a higher authority records an explicit override. Original
 * findings are never rewritten — an OVERTURNED appeal supersedes the finding and
 * releases the case's holds; the original stays in history.
 */
export async function decideAppeal(db: Database, input: DecideAppealInput): Promise<void> {
  return db.transaction(async (tx) => {
    const [appeal] = await tx.select().from(enforcementAppeals).where(eq(enforcementAppeals.id, input.appealId));
    if (!appeal) throw new EnforcementError('NOT_FOUND', 'Appeal not found.');
    await tx.execute(identityAdvisoryLockSql(appeal.customerIdentityId));
    if (['UPHELD', 'OVERTURNED', 'PARTIALLY_REMEDIATED', 'CLOSED'].includes(appeal.status)) {
      throw new EnforcementError('ALREADY_DECIDED', 'This appeal has already been decided.');
    }
    // Independence guard for serious decisions.
    if (input.decision !== 'INFORMATION_REQUESTED' && appeal.originalDeciderUserId && appeal.originalDeciderUserId === input.decidedByUserId && !input.overrideSameReviewer) {
      throw new EnforcementError('SAME_REVIEWER', 'An appeal of a serious decision may not be decided by the original reviewer without a higher-authority override.');
    }
    await tx.insert(enforcementAppealDecisions).values({
      organizationId: appeal.organizationId, appealId: appeal.id, caseId: appeal.caseId, decision: input.decision,
      decidedByUserId: input.decidedByUserId, rationaleInternal: input.rationaleInternal ?? null,
      customerSafeExplanation: input.customerSafeExplanation ?? null, overrideSameReviewer: input.overrideSameReviewer ?? false,
      overrideByUserId: input.overrideByUserId ?? null,
    });
    if (input.decision === 'INFORMATION_REQUESTED') {
      await tx.update(enforcementAppeals).set({ status: 'INFORMATION_REQUESTED', reviewerUserId: input.decidedByUserId, updatedAt: new Date(), version: appeal.version + 1 }).where(eq(enforcementAppeals.id, appeal.id));
    } else {
      await tx.update(enforcementAppeals).set({ status: input.decision, reviewerUserId: input.decidedByUserId, decisionAt: new Date(), customerSafeExplanation: input.customerSafeExplanation ?? null, updatedAt: new Date(), version: appeal.version + 1 }).where(eq(enforcementAppeals.id, appeal.id));
      // Case + finding effect. Original finding is preserved; overturn supersedes it.
      if (input.decision === 'OVERTURNED') {
        if (appeal.originalFindingId) {
          await tx.update(enforcementFindings).set({ status: 'SUPERSEDED' }).where(eq(enforcementFindings.id, appeal.originalFindingId));
        }
        const active = await tx.select().from(enforcementHolds).where(and(eq(enforcementHolds.caseId, appeal.caseId), eq(enforcementHolds.status, 'ACTIVE')));
        for (const h of active) await tx.update(enforcementHolds).set({ status: 'RELEASED', releasedAt: new Date(), releaseReason: 'Appeal overturned', version: h.version + 1 }).where(eq(enforcementHolds.id, h.id));
        await tx.update(enforcementCases).set({ status: 'OVERTURNED', updatedAt: new Date(), closedAt: new Date() }).where(eq(enforcementCases.id, appeal.caseId));
      } else if (input.decision === 'PARTIALLY_REMEDIATED') {
        await tx.update(enforcementCases).set({ status: 'RESOLVED_REMEDIATED', updatedAt: new Date(), closedAt: new Date() }).where(eq(enforcementCases.id, appeal.caseId));
      } else {
        await tx.update(enforcementCases).set({ status: 'FINALIZED', updatedAt: new Date(), closedAt: new Date() }).where(eq(enforcementCases.id, appeal.caseId));
      }
    }
    await recordAudit(tx, { organizationId: appeal.organizationId, actor: input.actor, subjectType: 'APPEAL', subjectId: appeal.id, userId: input.decidedByUserId, action: 'enforcement.appeal_decided', newState: { decision: input.decision, overrideSameReviewer: input.overrideSameReviewer ?? false }, reason: input.rationaleInternal ?? null });
    await events.publish(tx, { type: 'enforcement.appeal_decided', organizationId: appeal.organizationId, payload: { appealId: appeal.id, caseId: appeal.caseId, decision: input.decision, customerIdentityId: appeal.customerIdentityId } });
  });
}

// ---- reads ------------------------------------------------------------------

export async function listCases(db: Database, organizationId: string, filters: { status?: string; severity?: string; category?: string; assignedToUserId?: string; limit?: number } = {}): Promise<CaseRow[]> {
  const conds = [eq(enforcementCases.organizationId, organizationId)];
  if (filters.status) conds.push(eq(enforcementCases.status, filters.status));
  if (filters.severity) conds.push(eq(enforcementCases.severity, filters.severity));
  if (filters.category) conds.push(eq(enforcementCases.category, filters.category));
  if (filters.assignedToUserId) conds.push(eq(enforcementCases.assignedToUserId, filters.assignedToUserId));
  return db.select().from(enforcementCases).where(and(...conds)).orderBy(desc(enforcementCases.openedAt)).limit(Math.min(filters.limit ?? 100, 500));
}

export interface CaseDetail {
  case: CaseRow;
  signals: SignalRow[];
  evidence: (typeof enforcementEvidence.$inferSelect)[];
  findings: FindingRow[];
  actions: (typeof enforcementActions.$inferSelect)[];
  holds: HoldRow[];
  notes: (typeof enforcementNotes.$inferSelect)[];
  informationRequests: (typeof enforcementInformationRequests.$inferSelect)[];
  appeals: AppealRow[];
  appealDecisions: (typeof enforcementAppealDecisions.$inferSelect)[];
}

export async function caseDetail(db: Database, caseId: string): Promise<CaseDetail | null> {
  const c = await getCase(db, caseId);
  if (!c) return null;
  const [signals, evidence, findings, actions, holds, notes, informationRequests, appeals] = await Promise.all([
    db.select().from(enforcementSignals).where(eq(enforcementSignals.caseId, caseId)).orderBy(desc(enforcementSignals.occurredAt)),
    db.select().from(enforcementEvidence).where(eq(enforcementEvidence.caseId, caseId)).orderBy(desc(enforcementEvidence.capturedAt)),
    db.select().from(enforcementFindings).where(eq(enforcementFindings.caseId, caseId)).orderBy(desc(enforcementFindings.decidedAt)),
    db.select().from(enforcementActions).where(eq(enforcementActions.caseId, caseId)).orderBy(desc(enforcementActions.performedAt)),
    db.select().from(enforcementHolds).where(eq(enforcementHolds.caseId, caseId)).orderBy(desc(enforcementHolds.createdAt)),
    db.select().from(enforcementNotes).where(eq(enforcementNotes.caseId, caseId)).orderBy(desc(enforcementNotes.createdAt)),
    db.select().from(enforcementInformationRequests).where(eq(enforcementInformationRequests.caseId, caseId)).orderBy(desc(enforcementInformationRequests.requestedAt)),
    db.select().from(enforcementAppeals).where(eq(enforcementAppeals.caseId, caseId)),
  ]);
  const appealDecisions = appeals.length
    ? await db.select().from(enforcementAppealDecisions).where(eq(enforcementAppealDecisions.caseId, caseId)).orderBy(desc(enforcementAppealDecisions.decidedAt))
    : [];
  return { case: c, signals, evidence, findings, actions, holds, notes, informationRequests, appeals, appealDecisions };
}

export async function listHolds(db: Database, organizationId: string, filters: { status?: string; capability?: string } = {}): Promise<HoldRow[]> {
  const conds = [eq(enforcementHolds.organizationId, organizationId)];
  if (filters.status) conds.push(eq(enforcementHolds.status, filters.status));
  if (filters.capability) conds.push(eq(enforcementHolds.capability, filters.capability));
  return db.select().from(enforcementHolds).where(and(...conds)).orderBy(desc(enforcementHolds.createdAt)).limit(500);
}

export async function listSignals(db: Database, organizationId: string, limit = 200): Promise<SignalRow[]> {
  return db.select().from(enforcementSignals).where(eq(enforcementSignals.organizationId, organizationId)).orderBy(desc(enforcementSignals.capturedAt)).limit(limit);
}

export async function enforcementSummary(db: Database, organizationId: string): Promise<{ openCases: number; holds: number; appeals: number }> {
  const [oc] = await db.select({ n: sql<number>`count(*)::int` }).from(enforcementCases).where(and(eq(enforcementCases.organizationId, organizationId), inArray(enforcementCases.status, ['OPEN', 'TRIAGED', 'UNDER_REVIEW', 'AWAITING_CUSTOMER', 'ESCALATED', 'APPEALED', 'APPEAL_REVIEW'])));
  const [hd] = await db.select({ n: sql<number>`count(*)::int` }).from(enforcementHolds).where(and(eq(enforcementHolds.organizationId, organizationId), eq(enforcementHolds.status, 'ACTIVE')));
  const [ap] = await db.select({ n: sql<number>`count(*)::int` }).from(enforcementAppeals).where(and(eq(enforcementAppeals.organizationId, organizationId), inArray(enforcementAppeals.status, ['SUBMITTED', 'UNDER_REVIEW', 'INFORMATION_REQUESTED'])));
  return { openCases: oc?.n ?? 0, holds: hd?.n ?? 0, appeals: ap?.n ?? 0 };
}

/** The customer-safe view of a trader's own cases (never internal fields). */
export interface CustomerCaseView {
  reference: string;
  status: string;
  reason: string;
  openedAt: number;
  temporaryHolds: string[];
  informationRequest: { id: string; requestType: string; message: string; dueAt: number | null; responded: boolean } | null;
  appeal: { id: string; status: string; explanation: string | null } | null;
  appealAvailable: boolean;
}

export async function customerCaseViews(db: Database, customerIdentityId: string): Promise<CustomerCaseView[]> {
  const cases = await db.select().from(enforcementCases).where(eq(enforcementCases.customerIdentityId, customerIdentityId)).orderBy(desc(enforcementCases.openedAt)).limit(50);
  const out: CustomerCaseView[] = [];
  for (const c of cases) {
    // Only show cases the customer should be aware of (not silent INFO-only signals with no hold/request).
    const holds = await db.select().from(enforcementHolds).where(and(eq(enforcementHolds.caseId, c.id), eq(enforcementHolds.status, 'ACTIVE')));
    const [req] = await db.select().from(enforcementInformationRequests).where(and(eq(enforcementInformationRequests.caseId, c.id), eq(enforcementInformationRequests.responseStatus, 'PENDING'))).orderBy(desc(enforcementInformationRequests.requestedAt));
    const [appeal] = await db.select().from(enforcementAppeals).where(eq(enforcementAppeals.caseId, c.id));
    const elig = await appealEligibility(db, c.id);
    const visible = holds.length > 0 || req != null || appeal != null || c.status === 'CONFIRMED_VIOLATION' || c.status === 'AWAITING_CUSTOMER' || c.status === 'OVERTURNED' || c.status === 'RESOLVED_REMEDIATED';
    if (!visible) continue;
    out.push({
      reference: c.publicRef,
      status: c.status,
      reason: customerSafeMessage(c.customerSafeCategory as never),
      openedAt: c.openedAt.getTime(),
      temporaryHolds: [...new Set(holds.map((h) => h.capability))],
      informationRequest: req ? { id: req.id, requestType: req.requestType, message: req.messageSafe, dueAt: req.dueAt?.getTime() ?? null, responded: false } : null,
      appeal: appeal ? { id: appeal.id, status: appeal.status, explanation: appeal.customerSafeExplanation } : null,
      appealAvailable: elig.eligible,
    });
  }
  return out;
}
