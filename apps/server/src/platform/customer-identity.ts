/**
 * The permanent customer identity spine — "email is not the person".
 *
 * `customer_identities` sits beside `users` (the auth principal), one per user in
 * V1. It owns the denormalised `identity_status` and the guarded state machine
 * every verification step drives. Contact verification and identity verification
 * both call `advanceIdentityStatus`, which takes the identity's advisory lock,
 * re-reads under `FOR UPDATE`, refuses an illegal transition, and records an
 * audit (plus an optional domain event the caller supplies).
 *
 * Nothing here reaches into the trading engine or provisioning. The only coupling
 * to commerce is the read-only gate predicate in `provisioning-gate.ts`.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { customerIdentities } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events, type DomainEventType } from './events.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import { identityAdvisoryLockSql } from './identity-lock.js';

export type IdentityStatus =
  | 'UNVERIFIED'
  | 'CONTACT_PENDING'
  | 'CONTACT_VERIFIED'
  | 'IDENTITY_PENDING'
  | 'STEP_UP_REQUIRED'
  | 'UNDER_REVIEW'
  | 'IDENTITY_VERIFIED'
  | 'REJECTED';

export type CustomerIdentityRow = typeof customerIdentities.$inferSelect;

export class IdentityError extends Error {
  constructor(
    readonly code:
      | 'IDENTITY_NOT_FOUND'
      | 'ILLEGAL_TRANSITION'
      | 'ORGANIZATION_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * The legal identity-status transitions. Same-state is always an idempotent
 * no-op (not listed). A target not listed for the current state (and not equal to
 * it) is refused. IDENTITY_VERIFIED can regress ONLY via an explicit owner-forced
 * reverification (→ STEP_UP_REQUIRED / IDENTITY_PENDING).
 */
const IDENTITY_TRANSITIONS: Record<IdentityStatus, readonly IdentityStatus[]> = {
  UNVERIFIED: ['CONTACT_PENDING', 'CONTACT_VERIFIED'],
  CONTACT_PENDING: ['CONTACT_VERIFIED', 'UNVERIFIED'],
  CONTACT_VERIFIED: ['IDENTITY_PENDING'],
  IDENTITY_PENDING: ['IDENTITY_VERIFIED', 'STEP_UP_REQUIRED', 'UNDER_REVIEW', 'REJECTED'],
  STEP_UP_REQUIRED: ['IDENTITY_PENDING', 'IDENTITY_VERIFIED', 'UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['IDENTITY_VERIFIED', 'REJECTED', 'STEP_UP_REQUIRED'],
  IDENTITY_VERIFIED: ['STEP_UP_REQUIRED', 'IDENTITY_PENDING'],
  REJECTED: ['IDENTITY_PENDING'],
};

export function canTransitionIdentity(from: IdentityStatus, to: IdentityStatus): boolean {
  if (from === to) return true;
  return IDENTITY_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Get (or create) the customer identity for an authenticated user. Idempotent on
 * `user_id` (unique): a race to create two identities for one user resolves to
 * one via onConflictDoNothing + re-read, mirroring `createPendingOrder`.
 */
export async function ensureCustomerIdentity(
  db: Database,
  input: { organizationId: string; userId: string; actor?: Actor },
): Promise<CustomerIdentityRow> {
  const [existing] = await db
    .select()
    .from(customerIdentities)
    .where(eq(customerIdentities.userId, input.userId));
  if (existing) {
    if (existing.organizationId !== input.organizationId) {
      throw new IdentityError('ORGANIZATION_MISMATCH', 'Identity belongs to another organization.');
    }
    return existing;
  }
  const actor = input.actor ?? SYSTEM_ACTOR;
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [created] = await tx
      .insert(customerIdentities)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        status: 'ACTIVE',
        identityStatus: 'UNVERIFIED',
      })
      .onConflictDoNothing({ target: [customerIdentities.userId] })
      .returning();
    if (!created) {
      const [winner] = await tx
        .select()
        .from(customerIdentities)
        .where(eq(customerIdentities.userId, input.userId));
      return winner!;
    }
    await recordAudit(scoped, {
      organizationId: input.organizationId,
      actor,
      subjectType: 'CUSTOMER',
      subjectId: created.id,
      userId: input.userId,
      action: 'customer_identity.created',
      newState: { customerIdentityId: created.id },
      reason: null,
    });
    await events.publish(scoped, {
      type: 'customer_identity.created',
      organizationId: input.organizationId,
      userId: input.userId,
      payload: { customerIdentityId: created.id },
    });
    return created;
  });
}

export async function getCustomerIdentity(
  db: Database,
  identityId: string,
): Promise<CustomerIdentityRow | null> {
  const [row] = await db
    .select()
    .from(customerIdentities)
    .where(eq(customerIdentities.id, identityId));
  return row ?? null;
}

export async function getIdentityByUser(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<CustomerIdentityRow | null> {
  const [row] = await db
    .select()
    .from(customerIdentities)
    .where(
      and(eq(customerIdentities.organizationId, organizationId), eq(customerIdentities.userId, userId)),
    );
  return row ?? null;
}

/**
 * Advance the identity_status under the identity's advisory lock + FOR UPDATE.
 * Same-state is a no-op; an illegal transition throws. Records an audit; if the
 * caller supplies `event`, publishes it inside the same transaction (row written
 * first, subscribers are bystanders — identical to the account services).
 */
export async function advanceIdentityStatus(
  db: Database,
  input: {
    identityId: string;
    to: IdentityStatus;
    actor?: Actor;
    reason?: string | null;
    event?: { type: DomainEventType; payload: Record<string, unknown> };
  },
): Promise<CustomerIdentityRow> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  return db.transaction(async (tx) => {
    await tx.execute(identityAdvisoryLockSql(input.identityId));
    const [current] = await tx
      .select()
      .from(customerIdentities)
      .where(eq(customerIdentities.id, input.identityId))
      .for('update');
    if (!current) throw new IdentityError('IDENTITY_NOT_FOUND', 'No such identity.');
    const from = current.identityStatus as IdentityStatus;
    if (from === input.to) return current; // idempotent no-op
    if (!canTransitionIdentity(from, input.to)) {
      throw new IdentityError(
        'ILLEGAL_TRANSITION',
        `Cannot move identity from ${from} to ${input.to}.`,
      );
    }
    const scoped = tx as unknown as Database;
    const [updated] = await tx
      .update(customerIdentities)
      .set({ identityStatus: input.to, updatedAt: new Date() })
      .where(
        and(
          eq(customerIdentities.id, input.identityId),
          eq(customerIdentities.identityStatus, from),
        ),
      )
      .returning();
    if (!updated) {
      // A concurrent transition won under the lock; re-read and return it.
      const [now] = await tx
        .select()
        .from(customerIdentities)
        .where(eq(customerIdentities.id, input.identityId));
      return now!;
    }
    await recordAudit(scoped, {
      organizationId: current.organizationId,
      actor,
      subjectType: 'IDENTITY',
      subjectId: input.identityId,
      userId: current.userId,
      action: `identity.status.${input.to.toLowerCase()}`,
      prevState: { identityStatus: from },
      newState: { identityStatus: input.to },
      reason: input.reason ?? null,
    });
    if (input.event) {
      await events.publish(scoped, {
        type: input.event.type,
        organizationId: current.organizationId,
        userId: current.userId,
        payload: input.event.payload,
      });
    }
    return updated;
  });
}

/**
 * Capture personal/identity info (legal name, DOB, country) on the identity. Does
 * NOT change identity_status — that only moves through the verification steps.
 */
export async function updateIdentityInfo(
  db: Database,
  input: {
    identityId: string;
    legalName?: string | null;
    dateOfBirth?: string | null;
    country?: string | null;
    actor?: Actor;
  },
): Promise<CustomerIdentityRow> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  return db.transaction(async (tx) => {
    await tx.execute(identityAdvisoryLockSql(input.identityId));
    const [current] = await tx
      .select()
      .from(customerIdentities)
      .where(eq(customerIdentities.id, input.identityId))
      .for('update');
    if (!current) throw new IdentityError('IDENTITY_NOT_FOUND', 'No such identity.');
    const scoped = tx as unknown as Database;
    const [updated] = await tx
      .update(customerIdentities)
      .set({
        legalName: input.legalName ?? current.legalName,
        dateOfBirth: input.dateOfBirth ?? current.dateOfBirth,
        country: input.country ?? current.country,
        updatedAt: new Date(),
      })
      .where(eq(customerIdentities.id, input.identityId))
      .returning();
    await recordAudit(scoped, {
      organizationId: current.organizationId,
      actor,
      subjectType: 'IDENTITY',
      subjectId: input.identityId,
      userId: current.userId,
      action: 'identity.info_updated',
      // Do NOT log the values themselves beyond presence — PII minimisation.
      newState: {
        hasLegalName: Boolean(input.legalName ?? current.legalName),
        hasDob: Boolean(input.dateOfBirth ?? current.dateOfBirth),
        country: input.country ?? current.country ?? null,
      },
      reason: null,
    });
    return updated!;
  });
}

/**
 * Set the operational status (ACTIVE|HOLD|CLOSED). Distinct from verification —
 * an owner "place hold" action, audited with a reason.
 */
export async function setIdentityHold(
  db: Database,
  input: { identityId: string; status: 'ACTIVE' | 'HOLD' | 'CLOSED'; reason: string; actor: Actor },
): Promise<CustomerIdentityRow> {
  return db.transaction(async (tx) => {
    await tx.execute(identityAdvisoryLockSql(input.identityId));
    const [current] = await tx
      .select()
      .from(customerIdentities)
      .where(eq(customerIdentities.id, input.identityId))
      .for('update');
    if (!current) throw new IdentityError('IDENTITY_NOT_FOUND', 'No such identity.');
    const scoped = tx as unknown as Database;
    const [updated] = await tx
      .update(customerIdentities)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(customerIdentities.id, input.identityId))
      .returning();
    await recordAudit(scoped, {
      organizationId: current.organizationId,
      actor: input.actor,
      subjectType: 'CUSTOMER',
      subjectId: input.identityId,
      userId: current.userId,
      action: `customer_identity.${input.status.toLowerCase()}`,
      prevState: { status: current.status },
      newState: { status: input.status },
      reason: input.reason,
    });
    return updated!;
  });
}
