/**
 * Token issuance.
 *
 * Access tokens are short-lived HS256 JWTs carried on every request. Refresh
 * tokens are opaque random strings; only their SHA-256 hash is persisted, and
 * each use rotates the token so a captured refresh token is single-use.
 */
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface AccessTokenClaims {
  readonly sub: string;
  readonly email: string;
  /** Kept for tokens issued before roles existed. Authorization reads `role`. */
  readonly isAdmin: boolean;
  readonly role?: string;
  readonly organizationId?: string | null;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env().JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env().ACCESS_TOKEN_TTL_SECONDS,
    issuer: 'atlas-futures',
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const decoded = jwt.verify(token, env().JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'atlas-futures',
    });
    if (typeof decoded === 'string') return null;
    const { sub, email, isAdmin, role, organizationId } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof email !== 'string') return null;
    return {
      sub,
      email,
      isAdmin: isAdmin === true,
      // A token minted before roles existed carries none; an administrator's
      // flag still stands in for one until it expires.
      role: typeof role === 'string' ? role : isAdmin === true ? 'ADMIN' : 'TRADER',
      organizationId: typeof organizationId === 'string' ? organizationId : null,
    };
  } catch {
    return null;
  }
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshExpiry(): Date {
  return new Date(Date.now() + env().REFRESH_TOKEN_TTL_SECONDS * 1000);
}
