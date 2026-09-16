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

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
}

export interface AuthResult {
  readonly user: AuthenticatedUser;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export class AuthError extends Error {
  constructor(
    readonly code: 'EMAIL_TAKEN' | 'INVALID_CREDENTIALS' | 'INVALID_REFRESH' | 'USER_NOT_FOUND',
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
    accessToken: signAccessToken({ sub: user.id, email: user.email, isAdmin: user.isAdmin }),
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

  const passwordHash = await hashPassword(input.password);
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash, displayName: input.displayName })
    .returning();
  if (!row) throw new AuthError('USER_NOT_FOUND', 'Registration failed.');

  return issue(
    db,
    { id: row.id, email: row.email, displayName: row.displayName, isAdmin: row.isAdmin },
    userAgent,
  );
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

  return issue(
    db,
    { id: row.id, email: row.email, displayName: row.displayName, isAdmin: row.isAdmin },
    userAgent,
  );
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

  const result = await issue(
    db,
    { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin },
    userAgent,
  );
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

export async function getUserById(db: Database, id: string): Promise<AuthenticatedUser | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  if (!row) return null;
  return { id: row.id, email: row.email, displayName: row.displayName, isAdmin: row.isAdmin };
}
