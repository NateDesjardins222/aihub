/**
 * Step-up reauthentication for high-risk owner actions (M10-B).
 *
 * A high-risk endpoint requires a fresh, single-purpose step-up token, minted by
 * re-verifying the operator's password and scoped to a risk class. This is a
 * genuine server-side check, not a client-only password prompt: the token is a
 * short-lived HS256 JWT (distinct `typ`) verified on the protected route.
 */
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../config/env.js';
import { verifyPassword } from '../auth/password.js';
import { ApiError } from '../http/errors.js';
import type { ReauthClass } from './permissions.js';

const STEP_UP_TTL_SECONDS = 300; // 5 minutes

interface StepUpClaims {
  readonly typ: 'stepup';
  readonly sub: string;
  readonly cls: ReauthClass;
}

/** Re-verify the operator's password and mint a step-up token for a risk class. */
export async function mintStepUp(
  db: Database,
  userId: string,
  password: string,
  cls: ReauthClass,
): Promise<{ token: string; expiresInSeconds: number }> {
  const [u] = await db.select({ passwordHash: users.passwordHash, status: users.status }).from(users).where(eq(users.id, userId));
  if (!u || u.status !== 'ACTIVE') throw ApiError.unauthorized('Reauthentication failed.');
  const ok = await verifyPassword(password, u.passwordHash);
  if (!ok) throw ApiError.unauthorized('Reauthentication failed.');
  const claims: StepUpClaims = { typ: 'stepup', sub: userId, cls };
  const token = jwt.sign(claims, env().JWT_SECRET, { algorithm: 'HS256', expiresIn: STEP_UP_TTL_SECONDS, issuer: 'atlas-futures' });
  return { token, expiresInSeconds: STEP_UP_TTL_SECONDS };
}

/** True iff `token` is a valid, unexpired step-up for this user and class. */
export function verifyStepUp(token: string | undefined, userId: string, cls: ReauthClass): boolean {
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, env().JWT_SECRET, { algorithms: ['HS256'], issuer: 'atlas-futures' });
    if (typeof decoded === 'string') return false;
    const c = decoded as Record<string, unknown>;
    return c['typ'] === 'stepup' && c['sub'] === userId && c['cls'] === cls;
  } catch {
    return false;
  }
}
