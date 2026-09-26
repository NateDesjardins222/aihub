/**
 * Multi-factor authentication for operators (Phase 12.5).
 *
 * A real TOTP second factor: enrollment binds an authenticator to the account,
 * login requires a fresh code, and a set of single-use recovery codes is the
 * break-glass path if the authenticator is lost. Every state change is audited.
 *
 * Design choices that matter for safety:
 *   - The TOTP secret is sealed at rest (`secret-box`), so a database dump alone
 *     cannot mint codes.
 *   - Enrollment is two-phase: the secret is stored but `mfaEnrolled` stays
 *     false until the operator proves they can generate a current code. A
 *     half-finished enrollment can never lock anyone out.
 *   - Recovery codes are stored only as hashes and consumed by an atomic UPDATE,
 *     so a code is single-use even under concurrency and a database read cannot
 *     recover them.
 *   - Re-enrollment and disable delete every prior recovery code, so a code from
 *     a superseded enrollment is dead.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Database } from '../db/client.js';
import { mfaRecoveryCodes, users } from '../db/schema.js';
import { recordAudit } from '../platform/audit.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';
import { open, seal } from './secret-box.js';

export const RECOVERY_CODE_COUNT = 10;
const TOTP_ISSUER = 'Happy Trader Funding';

export class MfaError extends Error {
  constructor(
    readonly code:
      | 'ALREADY_ENROLLED'
      | 'NOT_ENROLLING'
      | 'NOT_ENROLLED'
      | 'INVALID_CODE'
      | 'USER_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'MfaError';
  }
}

export interface MfaStatus {
  readonly enrolled: boolean;
  readonly enrolledAt: Date | null;
  readonly recoveryCodesRemaining: number;
}

/** A recovery code's storage hash. High-entropy input, so SHA-256 is sufficient. */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
}

/** A human-transcribable recovery code: two 5-char base32 groups (~50 bits). */
function newRecoveryCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const pick = () => alphabet[randomInt(alphabet.length)];
  const group = () => Array.from({ length: 5 }, pick).join('');
  return `${group()}-${group()}`;
}

/** Present MFA status for a user without exposing any secret material. */
export async function mfaStatus(db: Database, userId: string): Promise<MfaStatus> {
  const [u] = await db
    .select({ enrolled: users.mfaEnrolled, enrolledAt: users.mfaEnrolledAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) throw new MfaError('USER_NOT_FOUND', 'User no longer exists.');
  const remaining = u.enrolled
    ? (
        await db
          .select({ id: mfaRecoveryCodes.id })
          .from(mfaRecoveryCodes)
          .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))
      ).length
    : 0;
  return { enrolled: u.enrolled, enrolledAt: u.enrolledAt ?? null, recoveryCodesRemaining: remaining };
}

/**
 * Begin enrollment: mint a fresh secret, seal it against the account, and return
 * the secret + otpauth URI for the operator to add to their authenticator. The
 * account is NOT considered enrolled until `activateEnrollment` proves a code.
 * Refuses if MFA is already active — disable first, so an accidental re-begin
 * cannot silently replace a working factor.
 */
export async function beginEnrollment(
  db: Database,
  userId: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const [u] = await db
    .select({ email: users.email, enrolled: users.mfaEnrolled, organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) throw new MfaError('USER_NOT_FOUND', 'User no longer exists.');
  if (u.enrolled) throw new MfaError('ALREADY_ENROLLED', 'MFA is already enabled. Disable it first to re-enroll.');

  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({ mfaSecret: seal(secret), mfaEnrolled: false, mfaEnrolledAt: null })
    .where(eq(users.id, userId));

  return { secret, otpauthUri: otpauthUri({ secretBase32: secret, accountName: u.email, issuer: TOTP_ISSUER }) };
}

/**
 * Activate a begun enrollment by proving a current code, then issue recovery
 * codes ONCE. Returns the plaintext recovery codes to show the operator; only
 * their hashes are persisted.
 */
export async function activateEnrollment(
  db: Database,
  userId: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const [u] = await db
    .select({
      sealed: users.mfaSecret,
      enrolled: users.mfaEnrolled,
      organizationId: users.organizationId,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) throw new MfaError('USER_NOT_FOUND', 'User no longer exists.');
  if (u.enrolled) throw new MfaError('ALREADY_ENROLLED', 'MFA is already enabled.');
  if (!u.sealed) throw new MfaError('NOT_ENROLLING', 'Start enrollment before confirming a code.');
  const secret = open(u.sealed);
  if (!secret) throw new MfaError('NOT_ENROLLING', 'Enrollment secret is unavailable; start again.');
  if (!verifyTotp(secret, code)) throw new MfaError('INVALID_CODE', 'That code is not valid.');

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await db.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
  await db
    .update(users)
    .set({ mfaEnrolled: true, mfaEnrolledAt: new Date() })
    .where(eq(users.id, userId));

  if (u.organizationId) {
    await recordAudit(db, {
      organizationId: u.organizationId,
      actor: { type: 'USER', userId, label: u.email },
      subjectType: 'USER',
      subjectId: userId,
      userId,
      action: 'user.mfa.enrolled',
    });
  }
  return { recoveryCodes: codes };
}

/**
 * Verify a login-time factor: a current TOTP, or a single-use recovery code.
 * Returns the method used, or null if neither matched. Recovery-code use is
 * atomic (the row is marked used in the matching UPDATE), so a code cannot be
 * spent twice even under a race.
 */
export async function verifyFactor(
  db: Database,
  userId: string,
  code: string,
): Promise<'TOTP' | 'RECOVERY' | null> {
  const [u] = await db
    .select({ sealed: users.mfaSecret, enrolled: users.mfaEnrolled })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || !u.enrolled || !u.sealed) return null;

  const secret = open(u.sealed);
  if (secret && verifyTotp(secret, code)) return 'TOTP';

  // Fall back to a recovery code: consume it atomically.
  const consumed = await db
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        eq(mfaRecoveryCodes.codeHash, hashRecoveryCode(code)),
        isNull(mfaRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id });
  return consumed.length > 0 ? 'RECOVERY' : null;
}

/**
 * Disable MFA. The caller must already have proven identity (password + a valid
 * factor at the route). Clears the secret and destroys every recovery code, so a
 * later re-enrollment starts clean.
 */
export async function disableMfa(db: Database, userId: string): Promise<void> {
  const [u] = await db
    .select({ enrolled: users.mfaEnrolled, organizationId: users.organizationId, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) throw new MfaError('USER_NOT_FOUND', 'User no longer exists.');
  if (!u.enrolled) throw new MfaError('NOT_ENROLLED', 'MFA is not enabled.');

  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await db
    .update(users)
    .set({ mfaEnrolled: false, mfaSecret: null, mfaEnrolledAt: null })
    .where(eq(users.id, userId));

  if (u.organizationId) {
    await recordAudit(db, {
      organizationId: u.organizationId,
      actor: { type: 'USER', userId, label: u.email },
      subjectType: 'USER',
      subjectId: userId,
      userId,
      action: 'user.mfa.disabled',
    });
  }
}

/** Re-issue recovery codes (e.g. after most are spent). Requires an active factor at the route. */
export async function regenerateRecoveryCodes(db: Database, userId: string): Promise<{ recoveryCodes: string[] }> {
  const [u] = await db
    .select({ enrolled: users.mfaEnrolled, organizationId: users.organizationId, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) throw new MfaError('USER_NOT_FOUND', 'User no longer exists.');
  if (!u.enrolled) throw new MfaError('NOT_ENROLLED', 'MFA is not enabled.');

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await db.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));

  if (u.organizationId) {
    await recordAudit(db, {
      organizationId: u.organizationId,
      actor: { type: 'USER', userId, label: u.email },
      subjectType: 'USER',
      subjectId: userId,
      userId,
      action: 'user.mfa.recovery_codes_regenerated',
    });
  }
  return { recoveryCodes: codes };
}
