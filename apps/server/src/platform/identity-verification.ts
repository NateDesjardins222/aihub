/**
 * Identity verification — the domain service that drives `identity_status` from
 * CONTACT_VERIFIED through IDENTITY_PENDING to a terminal decision, using the
 * pluggable `IdentityVerificationProvider`.
 *
 * It stores the DECISION and the provider reference, never the documents. Every
 * transition is explicit, audited (via `advanceIdentityStatus`), and idempotent.
 * A REJECTED/UNDER_REVIEW result is not a fraud conviction — it is appealable /
 * reviewable, and a new verification supersedes it.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { customerIdentities, identityVerifications } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { type DomainEventType } from './events.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import {
  advanceIdentityStatus,
  updateIdentityInfo,
  type IdentityStatus,
} from './customer-identity.js';
import {
  identityProviderFromEnv,
  ProviderUnconfiguredError,
  type IdentityVerificationProvider,
} from './identity-providers.js';

export type IdentityVerificationRow = typeof identityVerifications.$inferSelect;

export class IdentityVerificationError extends Error {
  constructor(
    readonly code:
      | 'IDENTITY_NOT_FOUND'
      | 'CONTACT_REQUIRED'
      | 'NO_VERIFICATION'
      | 'PROVIDER_UNCONFIGURED'
      | 'ALREADY_VERIFIED',
    message: string,
  ) {
    super(message);
    this.name = 'IdentityVerificationError';
  }
}

/** The decision states → the domain event each publishes when applied. */
const DECISION_EVENT: Partial<Record<IdentityStatus, DomainEventType>> = {
  IDENTITY_VERIFIED: 'identity.verified',
  STEP_UP_REQUIRED: 'identity.step_up_required',
  UNDER_REVIEW: 'identity.under_review',
  REJECTED: 'identity.rejected',
};

/**
 * Begin identity verification. Requires the contact half to be satisfied
 * (identity_status CONTACT_VERIFIED, or a re-verify state). Captures personal
 * info, asks the provider to create a verification, records an
 * identity_verifications row, and advances the identity to IDENTITY_PENDING with
 * an `identity.verification_started` event.
 */
export async function startIdentityVerification(
  db: Database,
  input: {
    identityId: string;
    legalName?: string | null;
    dob?: string | null;
    country?: string | null;
    email?: string | null;
    actor?: Actor;
    provider?: IdentityVerificationProvider;
  },
): Promise<{ verificationId: string; providerRef: string; status: IdentityStatus }> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const provider = input.provider ?? identityProviderFromEnv();

  const [identity] = await db
    .select()
    .from(customerIdentities)
    .where(eq(customerIdentities.id, input.identityId));
  if (!identity) throw new IdentityVerificationError('IDENTITY_NOT_FOUND', 'No such identity.');

  const status = identity.identityStatus as IdentityStatus;
  if (status === 'IDENTITY_VERIFIED') {
    throw new IdentityVerificationError('ALREADY_VERIFIED', 'Identity is already verified.');
  }
  const mayStart: IdentityStatus[] = ['CONTACT_VERIFIED', 'STEP_UP_REQUIRED', 'REJECTED', 'IDENTITY_PENDING'];
  if (!mayStart.includes(status)) {
    throw new IdentityVerificationError(
      'CONTACT_REQUIRED',
      'Verify a primary email and phone before starting identity verification.',
    );
  }

  // Capture info first (does not change status).
  await updateIdentityInfo(db, {
    identityId: input.identityId,
    legalName: input.legalName ?? null,
    dateOfBirth: input.dob ?? null,
    country: input.country ?? null,
    actor,
  });

  let created;
  try {
    created = await provider.createVerification({
      identityId: input.identityId,
      legalName: input.legalName ?? identity.legalName,
      dob: input.dob ?? (identity.dateOfBirth as string | null),
      country: input.country ?? identity.country,
      email: input.email ?? null,
    });
  } catch (err) {
    if (err instanceof ProviderUnconfiguredError) {
      throw new IdentityVerificationError(
        'PROVIDER_UNCONFIGURED',
        'The identity verification provider is not configured in this environment.',
      );
    }
    throw err;
  }

  const [row] = await db
    .insert(identityVerifications)
    .values({
      organizationId: identity.organizationId,
      customerIdentityId: input.identityId,
      provider: provider.name,
      providerRef: created.ref,
      status: 'IDENTITY_PENDING',
      legalName: input.legalName ?? identity.legalName,
      dateOfBirth: input.dob ?? (identity.dateOfBirth as string | null),
      addressJson: (created.address ?? null) as object | null,
    })
    .returning();

  await advanceIdentityStatus(db, {
    identityId: input.identityId,
    to: 'IDENTITY_PENDING',
    actor,
    event: {
      type: 'identity.verification_started',
      payload: { customerIdentityId: input.identityId, provider: provider.name },
    },
  });

  return { verificationId: row!.id, providerRef: created.ref, status: 'IDENTITY_PENDING' };
}

/**
 * Apply the provider's current decision for the identity's latest pending
 * verification (the webhook-driven or polled resolution). Idempotent: applying
 * the same terminal decision twice is a no-op. Updates the verification row and
 * advances identity_status with the mapped event.
 */
export async function resolveIdentityVerification(
  db: Database,
  input: {
    identityId: string;
    actor?: Actor;
    provider?: IdentityVerificationProvider;
    /** For a webhook: the raw provider event to normalise instead of polling. */
    event?: unknown;
  },
): Promise<{ status: IdentityStatus; reasonCode: string | null }> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const provider = input.provider ?? identityProviderFromEnv();

  const [latest] = await db
    .select()
    .from(identityVerifications)
    .where(eq(identityVerifications.customerIdentityId, input.identityId))
    .orderBy(desc(identityVerifications.createdAt))
    .limit(1);
  if (!latest || !latest.providerRef) {
    throw new IdentityVerificationError('NO_VERIFICATION', 'No verification to resolve.');
  }

  let decision;
  try {
    decision = input.event
      ? await provider.processProviderEvent({ ref: latest.providerRef, raw: input.event })
      : await provider.getVerificationStatus(latest.providerRef);
  } catch (err) {
    if (err instanceof ProviderUnconfiguredError) {
      throw new IdentityVerificationError(
        'PROVIDER_UNCONFIGURED',
        'The identity verification provider is not configured in this environment.',
      );
    }
    throw err;
  }

  const to = decision.status;
  const reasonCode = decision.reasonCode ?? null;

  // Update the verification row (decision + reason + decidedAt for terminal).
  const terminal = to === 'IDENTITY_VERIFIED' || to === 'REJECTED';
  await db
    .update(identityVerifications)
    .set({
      status: to,
      reasonCode,
      decidedAt: terminal ? new Date() : latest.decidedAt,
      updatedAt: new Date(),
    })
    .where(eq(identityVerifications.id, latest.id));

  const event = DECISION_EVENT[to];
  await advanceIdentityStatus(db, {
    identityId: input.identityId,
    to,
    actor,
    reason: reasonCode,
    ...(event
      ? { event: { type: event, payload: { customerIdentityId: input.identityId, reasonCode } } }
      : {}),
  });

  return { status: to, reasonCode };
}

/**
 * Owner action: require the customer to re-verify. Advances to STEP_UP_REQUIRED
 * with a reason + audit. RBAC is enforced at the route.
 */
export async function requireReverification(
  db: Database,
  input: { identityId: string; reason: string; actor: Actor; provider?: IdentityVerificationProvider },
): Promise<void> {
  const provider = input.provider ?? identityProviderFromEnv();
  const [latest] = await db
    .select()
    .from(identityVerifications)
    .where(eq(identityVerifications.customerIdentityId, input.identityId))
    .orderBy(desc(identityVerifications.createdAt))
    .limit(1);
  if (latest?.providerRef) {
    await provider.requestReverification(latest.providerRef, input.reason).catch(() => undefined);
  }
  await advanceIdentityStatus(db, {
    identityId: input.identityId,
    to: 'STEP_UP_REQUIRED',
    actor: input.actor,
    reason: input.reason,
    event: {
      type: 'identity.step_up_required',
      payload: { customerIdentityId: input.identityId, reason: 'OWNER_REQUESTED' },
    },
  });
}

export async function latestIdentityVerification(
  db: Database,
  identityId: string,
): Promise<IdentityVerificationRow | null> {
  const [row] = await db
    .select()
    .from(identityVerifications)
    .where(eq(identityVerifications.customerIdentityId, identityId))
    .orderBy(desc(identityVerifications.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Owner action (strong evidence + reason): clear an UNDER_REVIEW identity to
 * IDENTITY_VERIFIED, or decline it to REJECTED. Audited; not automatic.
 */
export async function ownerDecideReview(
  db: Database,
  input: { identityId: string; decision: 'IDENTITY_VERIFIED' | 'REJECTED'; reason: string; actor: Actor },
): Promise<void> {
  const [latest] = await db
    .select()
    .from(identityVerifications)
    .where(eq(identityVerifications.customerIdentityId, input.identityId))
    .orderBy(desc(identityVerifications.createdAt))
    .limit(1);
  if (latest) {
    await db
      .update(identityVerifications)
      .set({ status: input.decision, reasonCode: 'OWNER_DECISION', decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(identityVerifications.id, latest.id));
    await recordAudit(db, {
      organizationId: latest.organizationId,
      actor: input.actor,
      subjectType: 'IDENTITY',
      subjectId: input.identityId,
      action: `identity.owner_${input.decision === 'IDENTITY_VERIFIED' ? 'approved' : 'rejected'}`,
      newState: { status: input.decision },
      reason: input.reason,
    });
  }
  const event = DECISION_EVENT[input.decision];
  await advanceIdentityStatus(db, {
    identityId: input.identityId,
    to: input.decision,
    actor: input.actor,
    reason: input.reason,
    ...(event ? { event: { type: event, payload: { customerIdentityId: input.identityId } } } : {}),
  });
}
