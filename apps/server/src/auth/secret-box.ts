/**
 * Authenticated encryption for small secrets stored at rest (Phase 12.5).
 *
 * The one thing that must NOT sit in the database in the clear is a TOTP shared
 * secret: a read-only database dump would otherwise let an attacker mint valid
 * second-factor codes. So the secret is sealed with AES-256-GCM under a key
 * derived from `JWT_SECRET` (HKDF-SHA256, a fixed info label). That ties
 * decryption to a value that production already requires to be a strong private
 * secret (`productionMisconfiguration` refuses to boot on the dev default), so
 * possession of the database alone is not enough — you also need the app secret.
 *
 * The wire format is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version
 * prefix lets the key derivation or cipher change later without guessing.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce length.

/** 32-byte AES key derived from JWT_SECRET; recomputed per call (cheap, HKDF). */
function key(): Buffer {
  const secret = env().JWT_SECRET;
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('atlas.mfa.secret.v1'), 32),
  );
}

/** Seal a UTF-8 plaintext. Output is safe to store in a text column. */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Open a sealed value, or return null if it is malformed, was sealed under a
 * different key, or has been tampered with (the GCM tag will not verify). The
 * caller treats null as "no usable secret" and fails closed.
 */
export function open(sealed: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[2]!, 'base64url');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
