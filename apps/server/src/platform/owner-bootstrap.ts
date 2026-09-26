/**
 * Secure production owner bootstrap (Phase 12.5).
 *
 * The development seed creates a known `owner@atlasfutures.local` SUPER_ADMIN and
 * therefore REFUSES to run in production (`seed-guard`). That left production with
 * no way to create its first operator — a hard NO-GO for any real-infra mode.
 *
 * This is that way, and it is deliberately narrow:
 *   - It creates the FIRST operator only. If any SUPER_ADMIN already exists it
 *     refuses, so it can never mint a second hidden owner or overwrite one.
 *   - The credentials come from the caller (the CLI reads them from the
 *     environment), never from source. No password is ever hard-coded, logged or
 *     returned.
 *   - It enforces a minimum password strength, because this is the single most
 *     privileged account in the system.
 *   - It is pure of any process/exit concern so it can be unit-tested; the CLI
 *     wrapper adds the environment gate and the human-facing output.
 *
 * The created owner has NO MFA yet: enrolling a second factor is the operator's
 * first action on first login (see docs). Bootstrap does not enroll it because
 * the TOTP secret must be shown to a human at an authenticator, not printed by a
 * script into a terminal log.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { recordAudit } from './audit.js';
import { defaultOrganizationId } from './provisioning.js';

export const MIN_OWNER_PASSWORD_LENGTH = 12;

export class OwnerBootstrapError extends Error {
  constructor(
    readonly code: 'OWNER_EXISTS' | 'WEAK_PASSWORD' | 'INVALID_EMAIL' | 'EMAIL_TAKEN',
    message: string,
  ) {
    super(message);
    this.name = 'OwnerBootstrapError';
  }
}

export interface BootstrapInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface BootstrapResult {
  readonly userId: string;
  readonly email: string;
  readonly organizationId: string;
}

/** True iff at least one SUPER_ADMIN already exists — the bootstrap is a one-time gate. */
export async function ownerExists(db: Database): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'SUPER_ADMIN'))
    .limit(1);
  return rows.length > 0;
}

/**
 * Create the first SUPER_ADMIN. Refuses if one already exists. Never returns or
 * logs the password. The organisation is created if absent (the same `atlas`
 * default the rest of the system uses).
 */
export async function bootstrapOwner(db: Database, input: BootstrapInput): Promise<BootstrapResult> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new OwnerBootstrapError('INVALID_EMAIL', 'A valid email address is required.');
  }
  if (input.password.length < MIN_OWNER_PASSWORD_LENGTH) {
    throw new OwnerBootstrapError(
      'WEAK_PASSWORD',
      `The owner password must be at least ${MIN_OWNER_PASSWORD_LENGTH} characters.`,
    );
  }
  if (await ownerExists(db)) {
    throw new OwnerBootstrapError(
      'OWNER_EXISTS',
      'An owner already exists. Bootstrap creates the first operator only; use the owner console to add staff.',
    );
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing.length > 0) {
    throw new OwnerBootstrapError('EMAIL_TAKEN', 'That email is already registered.');
  }

  const organizationId = await defaultOrganizationId(db);
  const passwordHash = await hashPassword(input.password);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: input.displayName?.trim() || 'Owner',
      organizationId,
      role: 'SUPER_ADMIN',
      isAdmin: true,
      status: 'ACTIVE',
    })
    .returning();
  if (!row) throw new OwnerBootstrapError('EMAIL_TAKEN', 'Owner creation failed.');

  await recordAudit(db, {
    organizationId,
    actor: { type: 'SYSTEM', label: 'owner-bootstrap' },
    subjectType: 'USER',
    subjectId: row.id,
    userId: row.id,
    action: 'owner.bootstrapped',
    newState: { email: row.email, role: row.role },
  });

  // Ensure the org row is present for a truly empty database.
  await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId));

  return { userId: row.id, email: row.email, organizationId };
}
