/** Authentication service: registration, login, refresh rotation, revocation. */
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { refreshTokens, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiry,
  signAccessToken,
} from './tokens.js';
import { env } from '../config/env.js';
import { defaultOrganizationId, ensurePracticeAccount } from '../platform/provisioning.js';
import { recordAudit } from '../platform/audit.js';
import { events } from '../platform/events.js';

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly role: UserRole;
  readonly organizationId: string | null;
}

export type UserRole = 'TRADER' | 'SUPPORT' | 'ADMIN' | 'SUPER_ADMIN';

const ROLES: readonly UserRole[] = ['TRADER', 'SUPPORT', 'ADMIN', 'SUPER_ADMIN'];

function readRole(value: string, isAdmin: boolean): UserRole {
  if ((ROLES as string[]).includes(value)) return value as UserRole;
  // A row written before roles existed still has its administrator flag.
  return isAdmin ? 'ADMIN' : 'TRADER';
}

export interface AuthResult {
  readonly user: AuthenticatedUser;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export class AuthError extends Error {
  constructor(
    readonly code:
      | 'EMAIL_TAKEN'
      | 'INVALID_CREDENTIALS'
      | 'INVALID_REFRESH'
      | 'USER_NOT_FOUND'
      | 'USER_DISABLED',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function issue(
  db: Database,
  user: AuthenticatedUser,
  userAgent: string | null,
): Promise<AuthResult> {
  const { token, hash } = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: hash,
    expiresAt: refreshExpiry(),
    userAgent,
  });
  return {
    user,
    accessToken: signAccessToken({
      sub: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      role: user.role,
      organizationId: user.organizationId,
    }),
    refreshToken: token,
    expiresIn: env().ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function register(
  db: Database,
  input: { email: string; password: string; displayName: string },
  userAgent: string | null = null,
): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing.length > 0) throw new AuthError('EMAIL_TAKEN', 'That email is already registered.');

  const organizationId = await defaultOrganizationId(db);
  const passwordHash = await hashPassword(input.password);
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash, displayName: input.displayName, organizationId })
    .returning();
  if (!row) throw new AuthError('USER_NOT_FOUND', 'Registration failed.');

  await recordAudit(db, {
    organizationId,
    actor: { type: 'USER', userId: row.id, label: row.email },
    subjectType: 'USER',
    subjectId: row.id,
    userId: row.id,
    action: 'user.created',
    newState: { email: row.email, displayName: row.displayName, role: row.role },
  });
  await events.publish(db, {
    type: 'user.created',
    organizationId,
    userId: row.id,
    payload: { email: row.email, displayName: row.displayName },
  });

  /*
   * The practice account.
   *
   * Provisioned through the ordinary provisioning service, with the same
   * product, lifecycle, audit trail and rule configuration as any other
   * account. It is not a frontend convenience and not a seed-script special
   * case: a new trader signs in and an account is simply there.
   */
  await ensurePracticeAccount(db, row.id, organizationId);

  return issue(db, present(row), userAgent);
}

export async function login(
  db: Database,
  input: { email: string; password: string },
  userAgent: string | null = null,
): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const [row] = await db.select().from(users).where(eq(users.email, email));

  // Always run a verification so a missing account and a wrong password take
  // comparable time; otherwise the endpoint enumerates registered addresses.
  const stored = row?.passwordHash ?? (await hashPassword('placeholder-for-timing'));
  const ok = await verifyPassword(input.password, stored);
  if (!row || !ok) throw new AuthError('INVALID_CREDENTIALS', 'Incorrect email or password.');
  if (row.status !== 'ACTIVE') {
    throw new AuthError('USER_DISABLED', 'This account has been disabled.');
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));

  return issue(db, present(row), userAgent);
}

/**
 * Exchange a refresh token for a new pair. The presented token is revoked in the
 * same statement it is validated by, so two concurrent refreshes cannot both win.
 */
export async function refresh(
  db: Database,
  presented: string,
  userAgent: string | null = null,
): Promise<AuthResult> {
  const hash = hashRefreshToken(presented);
  const now = new Date();

  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)))
    .returning();

  const record = revoked[0];
  if (!record) throw new AuthError('INVALID_REFRESH', 'Refresh token is invalid or already used.');
  if (record.expiresAt.getTime() < now.getTime()) {
    throw new AuthError('INVALID_REFRESH', 'Refresh token has expired.');
  }

  const [user] = await db.select().from(users).where(eq(users.id, record.userId));
  if (!user) throw new AuthError('USER_NOT_FOUND', 'User no longer exists.');
  // A user disabled mid-session cannot refresh their way back in.
  if (user.status !== 'ACTIVE') throw new AuthError('USER_DISABLED', 'This account has been disabled.');

  const result = await issue(db, present(user), userAgent);
  await db
    .update(refreshTokens)
    .set({ replacedByTokenHash: hashRefreshToken(result.refreshToken) })
    .where(eq(refreshTokens.id, record.id));
  return result;
}

export async function logout(db: Database, presented: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, hashRefreshToken(presented)), isNull(refreshTokens.revokedAt)));
}

/**
 * Revoke EVERY active refresh token for a user (M7 enforcement containment /
 * "force re-auth"). Login and refresh already reject a non-ACTIVE user; this
 * additionally invalidates outstanding refresh tokens so the next refresh fails.
 * A short-lived access token already issued expires on its own TTL. Returns the
 * number of tokens revoked. Idempotent.
 */
export async function revokeAllSessions(db: Database, userId: string): Promise<number> {
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return revoked.length;
}

export async function getUserById(db: Database, id: string): Promise<AuthenticatedUser | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  if (!row) return null;
  return present(row);
}

type UserRow = typeof users.$inferSelect;

function present(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    role: readRole(row.role, row.isAdmin),
    organizationId: row.organizationId,
  };
}
