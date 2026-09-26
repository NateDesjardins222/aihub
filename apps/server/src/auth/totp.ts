/**
 * Time-based one-time passwords (RFC 6238) and their base32 secrets (RFC 4648),
 * implemented on `node:crypto` alone.
 *
 * Why no library: a TOTP verifier is ~60 lines of standard-library HMAC, and a
 * dependency here would be a supply-chain surface on the exact path that
 * protects the owner account. Everything is pure and deterministic given a
 * clock, so it is unit-testable without mocking a network or a database.
 *
 * The verifier is deliberately strict: SHA-1 (what every authenticator app
 * implements), 6 digits, a 30-second step, and a ±1 step window to tolerate
 * clock skew and a code typed as it rolls over — no wider. Comparison is
 * constant-time so a code cannot be recovered a digit at a time by timing.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32 alphabet (no padding on output). */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** Accept the previous, current and next step: ±30s of skew, nothing wider. */
export const TOTP_WINDOW = 1;

/** Encode raw bytes as unpadded base32 (uppercase). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode a base32 string to bytes. Tolerant of lowercase, spaces and `=`
 * padding (all of which show up when a human retypes a secret), and rejects any
 * character outside the alphabet by returning null rather than guessing.
 */
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh random TOTP secret, as a base32 string suitable for an authenticator. */
export function generateTotpSecret(bytes = 20): string {
  // 20 bytes = 160 bits, the RFC 4226 recommended HMAC-SHA1 key length.
  return base32Encode(randomBytes(bytes));
}

/** The 8-byte big-endian counter for a given step, as HOTP requires. */
function counterBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8);
  // Counters never exceed 2^53, so the high word is written from the float.
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter % 0x1_0000_0000, 4);
  return buf;
}

/** The HOTP value for a base32 secret and counter, zero-padded to `digits`. */
function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const hmac = createHmac('sha1', secret).update(counterBuffer(counter)).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** The current TOTP code for a base32 secret at a given time (default: now). */
export function totpCode(secretBase32: string, atMs: number = Date.now()): string | null {
  const secret = base32Decode(secretBase32);
  if (!secret) return null;
  const counter = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
  return hotp(secret, counter);
}

/**
 * True iff `code` is a valid TOTP for the secret within ±`window` steps of now.
 * The comparison is constant-time and length-checked, so neither a wrong length
 * nor a partially-correct code leaks timing.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atMs: number = Date.now(),
  window = TOTP_WINDOW,
): boolean {
  const secret = base32Decode(secretBase32);
  if (!secret) return false;
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  const current = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
  const candidate = Buffer.from(trimmed);
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = Buffer.from(hotp(secret, current + drift));
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return true;
    }
  }
  return false;
}

/**
 * The otpauth:// URI an authenticator app imports (typically via QR). The label
 * is `issuer:account`; the secret is the base32 string. No secret ever appears
 * in a log because this string is returned to the enrolling operator once and
 * never persisted.
 */
export function otpauthUri(params: {
  secretBase32: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
