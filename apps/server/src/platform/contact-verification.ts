/**
 * Contact verification — proving a customer can be reached at an email or phone.
 *
 * A short-lived, attempt-capped, TTL'd challenge. The plaintext code is NEVER
 * stored (only a salted SHA-256) and NEVER returned in a production response; in
 * local/test mode a dev-only accessor exposes it to the browser harness. Verified
 * contact is NOT verified identity — it only satisfies the contact half of the
 * provisioning gate.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  contactVerificationChallenges,
  customerIdentities,
  verifiedContacts,
} from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import { identityAdvisoryLockSql } from './identity-lock.js';
import { advanceIdentityStatus, type IdentityStatus } from './customer-identity.js';
import { env } from '../config/env.js';

export type ContactChannel = 'EMAIL' | 'SMS';

export class ContactVerificationError extends Error {
  constructor(
    readonly code:
      | 'IDENTITY_NOT_FOUND'
      | 'CHALLENGE_NOT_FOUND'
      | 'CHALLENGE_EXPIRED'
      | 'CHALLENGE_CONSUMED'
      | 'TOO_MANY_ATTEMPTS'
      | 'INVALID_CODE'
      | 'INVALID_CONTACT',
    message: string,
  ) {
    super(message);
    this.name = 'ContactVerificationError';
  }
}

const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Dev/test only: the plaintext code by challenge id, so the browser harness and
 * integration tests can confirm a challenge without a real email/SMS provider.
 * Populated ONLY when NODE_ENV !== 'production'; never in production.
 */
const devCodes = new Map<string, string>();

export function __devPeekCode(challengeId: string): string | undefined {
  if (env().NODE_ENV === 'production') return undefined;
  return devCodes.get(challengeId);
}

function normalizeContact(channel: ContactChannel, raw: string): string {
  const trimmed = raw.trim();
  if (channel === 'EMAIL') {
    const lower = trimmed.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lower)) {
      throw new ContactVerificationError('INVALID_CONTACT', 'Not a valid email address.');
    }
    return lower;
  }
  // SMS: keep a leading + and digits only (a light E.164 normalisation).
  const digits = trimmed.replace(/[^\d+]/g, '');
  const e164 = digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : digits;
  if (!/^\+?\d{7,15}$/.test(e164)) {
    throw new ContactVerificationError('INVALID_CONTACT', 'Not a valid phone number.');
  }
  return e164;
}

function hashCode(salt: string, code: string): string {
  return createHash('sha256').update(salt).update('\n').update(code).digest('hex');
}

/**
 * Begin verifying a contact. Voids any live challenge for the same (identity,
 * channel, value) so only one code is live, mints a 6-digit code, stores only its
 * salted hash + a short TTL, and publishes `contact.challenge_started` (the
 * notification worker turns this into a VERIFY_EMAIL / VERIFY_PHONE message — it
 * NEVER blocks on a provider). The plaintext code is not returned in production.
 */
export async function startContactVerification(
  db: Database,
  input: { identityId: string; channel: ContactChannel; value: string; actor?: Actor },
): Promise<{ challengeId: string; expiresAt: Date; devCode?: string }> {
  const value = normalizeContact(input.channel, input.value);
  const actor = input.actor ?? SYSTEM_ACTOR;

  const [identity] = await db
    .select()
    .from(customerIdentities)
    .where(eq(customerIdentities.id, input.identityId));
  if (!identity) throw new ContactVerificationError('IDENTITY_NOT_FOUND', 'No such identity.');

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const salt = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  const challengeId = await db.transaction(async (tx) => {
    await tx.execute(identityAdvisoryLockSql(input.identityId));
    // Void any live challenge for this exact target.
    await tx
      .update(contactVerificationChallenges)
      .set({ status: 'VOID' })
      .where(
        and(
          eq(contactVerificationChallenges.customerIdentityId, input.identityId),
          eq(contactVerificationChallenges.channel, input.channel),
          eq(contactVerificationChallenges.value, value),
          eq(contactVerificationChallenges.status, 'PENDING'),
        ),
      );
    const [challenge] = await tx
      .insert(contactVerificationChallenges)
      .values({
        organizationId: identity.organizationId,
        customerIdentityId: input.identityId,
        channel: input.channel,
        value,
        codeHash: hashCode(salt, code),
        salt,
        status: 'PENDING',
        expiresAt,
      })
      .returning();
    // Ensure a PENDING verified_contacts row exists for this target.
    await tx
      .insert(verifiedContacts)
      .values({
        organizationId: identity.organizationId,
        customerIdentityId: input.identityId,
        channel: input.channel,
        value,
        status: 'PENDING',
      })
      .onConflictDoNothing({
        target: [
          verifiedContacts.customerIdentityId,
          verifiedContacts.channel,
          verifiedContacts.value,
        ],
      });
    const scoped = tx as unknown as Database;
    // If the identity is still UNVERIFIED, mark contact verification in progress.
    if ((identity.identityStatus as IdentityStatus) === 'UNVERIFIED') {
      await tx
        .update(customerIdentities)
        .set({ identityStatus: 'CONTACT_PENDING', updatedAt: new Date() })
        .where(
          and(
            eq(customerIdentities.id, input.identityId),
            eq(customerIdentities.identityStatus, 'UNVERIFIED'),
          ),
        );
    }
    await recordAudit(scoped, {
      organizationId: identity.organizationId,
      actor,
      subjectType: 'IDENTITY',
      subjectId: input.identityId,
      userId: identity.userId,
      action: 'contact.challenge_started',
      // Never log the code. Channel + a masked value only.
      newState: { channel: input.channel, challengeId: challenge!.id },
      reason: null,
    });
    await events.publish(scoped, {
      type: 'contact.challenge_started',
      organizationId: identity.organizationId,
      userId: identity.userId,
      payload: {
        customerIdentityId: input.identityId,
        challengeId: challenge!.id,
        channel: input.channel,
        // The code is passed to the notification layer out-of-band (see
        // notifications-v1.md); it is deliberately NOT persisted in the event.
      },
    });
    return challenge!.id;
  });

  if (env().NODE_ENV !== 'production') devCodes.set(challengeId, code);
  return {
    challengeId,
    expiresAt,
    ...(env().NODE_ENV !== 'production' ? { devCode: code } : {}),
  };
}

/**
 * Confirm a challenge. Under the identity lock: refuses expired/consumed/void,
 * counts wrong attempts and voids on exceeding the cap (brute-force guard), and on
 * a constant-time match marks the challenge CONSUMED, the contact VERIFIED (first
 * of its channel becomes primary), and — when both a primary email and phone are
 * verified and the identity has not progressed past contact — advances the
 * identity to CONTACT_VERIFIED.
 */
export async function confirmContactVerification(
  db: Database,
  input: { challengeId: string; code: string; actor?: Actor },
): Promise<{ verified: true; channel: ContactChannel; identityAdvanced: boolean }> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  // The transaction returns an outcome rather than throwing on a failed attempt,
  // because a throw would roll back the very increment/void we need to persist —
  // so a brute-force guard that reset every call would never trip. On a failure
  // the tx commits its side effect and we throw AFTER it commits.
  type Outcome =
    | { kind: 'ERROR'; error: ContactVerificationError }
    | {
        kind: 'OK';
        channel: ContactChannel;
        identityId: string;
        identityStatus: IdentityStatus;
      };
  const result = await db.transaction(async (tx): Promise<Outcome> => {
    const [challenge] = await tx
      .select()
      .from(contactVerificationChallenges)
      .where(eq(contactVerificationChallenges.id, input.challengeId))
      .for('update');
    if (!challenge) {
      return { kind: 'ERROR', error: new ContactVerificationError('CHALLENGE_NOT_FOUND', 'No such challenge.') };
    }

    await tx.execute(identityAdvisoryLockSql(challenge.customerIdentityId));

    if (challenge.status === 'CONSUMED') {
      return { kind: 'ERROR', error: new ContactVerificationError('CHALLENGE_CONSUMED', 'Already verified.') };
    }
    if (challenge.status !== 'PENDING' || challenge.expiresAt.getTime() < Date.now()) {
      if (challenge.status === 'PENDING') {
        await tx
          .update(contactVerificationChallenges)
          .set({ status: 'EXPIRED' })
          .where(eq(contactVerificationChallenges.id, challenge.id));
      }
      return { kind: 'ERROR', error: new ContactVerificationError('CHALLENGE_EXPIRED', 'This code has expired.') };
    }
    if (challenge.attempts >= challenge.maxAttempts) {
      await tx
        .update(contactVerificationChallenges)
        .set({ status: 'VOID' })
        .where(eq(contactVerificationChallenges.id, challenge.id));
      return { kind: 'ERROR', error: new ContactVerificationError('TOO_MANY_ATTEMPTS', 'Too many attempts; request a new code.') };
    }

    const expected = Buffer.from(challenge.codeHash, 'hex');
    const actual = Buffer.from(hashCode(challenge.salt, input.code.trim()), 'hex');
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) {
      // Commit the increment (the transaction returns rather than throws, so this
      // survives). The next call that sees attempts at the cap trips the guard
      // above and reports TOO_MANY_ATTEMPTS.
      await tx
        .update(contactVerificationChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(contactVerificationChallenges.id, challenge.id));
      return { kind: 'ERROR', error: new ContactVerificationError('INVALID_CODE', 'That code is not correct.') };
    }

    // Consume the challenge and verify the contact.
    await tx
      .update(contactVerificationChallenges)
      .set({ status: 'CONSUMED', consumedAt: new Date() })
      .where(eq(contactVerificationChallenges.id, challenge.id));

    const existingOfChannel = await tx
      .select({ id: verifiedContacts.id, isPrimary: verifiedContacts.isPrimary })
      .from(verifiedContacts)
      .where(
        and(
          eq(verifiedContacts.customerIdentityId, challenge.customerIdentityId),
          eq(verifiedContacts.channel, challenge.channel),
          eq(verifiedContacts.status, 'VERIFIED'),
        ),
      );
    const makePrimary = existingOfChannel.length === 0;

    await tx
      .update(verifiedContacts)
      .set({
        status: 'VERIFIED',
        isPrimary: makePrimary,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(verifiedContacts.customerIdentityId, challenge.customerIdentityId),
          eq(verifiedContacts.channel, challenge.channel),
          eq(verifiedContacts.value, challenge.value),
        ),
      );

    const scoped = tx as unknown as Database;
    const [identity] = await tx
      .select()
      .from(customerIdentities)
      .where(eq(customerIdentities.id, challenge.customerIdentityId));
    await recordAudit(scoped, {
      organizationId: challenge.organizationId,
      actor,
      subjectType: 'IDENTITY',
      subjectId: challenge.customerIdentityId,
      userId: identity?.userId,
      action: 'contact.verified',
      newState: { channel: challenge.channel },
      reason: null,
    });
    await events.publish(scoped, {
      type: 'contact.verified',
      organizationId: challenge.organizationId,
      userId: identity?.userId,
      payload: { customerIdentityId: challenge.customerIdentityId, channel: challenge.channel },
    });

    devCodes.delete(challenge.id);
    return {
      kind: 'OK',
      channel: challenge.channel as ContactChannel,
      identityId: challenge.customerIdentityId,
      identityStatus: (identity?.identityStatus ?? 'UNVERIFIED') as IdentityStatus,
    };
  });

  if (result.kind === 'ERROR') throw result.error;

  // If both primary contacts are now verified and the identity is still at the
  // contact stage, advance it to CONTACT_VERIFIED (a distinct, audited step).
  let identityAdvanced = false;
  if (result.identityStatus === 'UNVERIFIED' || result.identityStatus === 'CONTACT_PENDING') {
    const both = await primaryContactsVerified(db, result.identityId);
    if (both.email && both.sms) {
      await advanceIdentityStatus(db, {
        identityId: result.identityId,
        to: 'CONTACT_VERIFIED',
        actor,
      });
      identityAdvanced = true;
    }
  }

  return { verified: true, channel: result.channel, identityAdvanced };
}

/** Which primary channels are VERIFIED for an identity — the contact half of the gate. */
export async function primaryContactsVerified(
  db: Database,
  identityId: string,
): Promise<{ email: boolean; sms: boolean }> {
  const rows = await db
    .select({ channel: verifiedContacts.channel })
    .from(verifiedContacts)
    .where(
      and(
        eq(verifiedContacts.customerIdentityId, identityId),
        eq(verifiedContacts.status, 'VERIFIED'),
        eq(verifiedContacts.isPrimary, true),
      ),
    );
  return {
    email: rows.some((r) => r.channel === 'EMAIL'),
    sms: rows.some((r) => r.channel === 'SMS'),
  };
}

/** The primary verified address for a channel, for addressing a notification. */
export async function primaryContactValue(
  db: Database,
  identityId: string,
  channel: ContactChannel,
): Promise<string | null> {
  const [row] = await db
    .select({ value: verifiedContacts.value })
    .from(verifiedContacts)
    .where(
      and(
        eq(verifiedContacts.customerIdentityId, identityId),
        eq(verifiedContacts.channel, channel),
        eq(verifiedContacts.status, 'VERIFIED'),
        eq(verifiedContacts.isPrimary, true),
      ),
    );
  return row?.value ?? null;
}
