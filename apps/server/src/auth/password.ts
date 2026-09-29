/**
 * Password hashing using scrypt from node:crypto.
 *
 * scrypt is memory-hard and available in the standard library, which avoids a
 * native build step in every deployment target. Parameters follow current
 * guidance (N=2^15, r=8, p=1) and are encoded into the stored hash so they can
 * be raised later without invalidating existing credentials.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Production parameters follow current guidance (N=2^15). Under the test runner
 * (Vitest sets VITEST=true; NODE_ENV=test is a fallback) we lower the work factor
 * dramatically. scrypt is memory-hard (~128·N·r bytes ≈ 32 MB per op at N=2^15),
 * and auth-heavy suites hash + verify passwords in per-test setup hooks; under
 * heavy parallel-worker contention that CPU/memory storm made the release suite
 * non-deterministic (KNOWN_ISSUES PV2-G1: a `beforeEach` doing four scrypt ops
 * blew its 10s budget). The algorithm and stored-hash format are IDENTICAL — only
 * the work factor changes, and N/r/p are encoded per hash, so a hash written with
 * one cost still verifies under any other. Production (NODE_ENV=production, never
 * VITEST) is unaffected: it always uses the strong parameters.
 */
export interface ScryptParams { N: number; r: number; p: number; maxmem: number }

/** Production (strong) and test (fast) scrypt parameters. */
export const PROD_SCRYPT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const TEST_SCRYPT_PARAMS: ScryptParams = { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

/**
 * Select the scrypt work factor from the environment. The test (low) factor is
 * chosen ONLY when the process is unambiguously a test runner: `VITEST === 'true'`
 * (strict) OR `NODE_ENV === 'test'`. Every other environment — including production
 * (`NODE_ENV === 'production'`) AND the default with NO env set — gets the strong
 * production factor. This is a PURE function of its input so the selection can be
 * proven mechanically (Resilience Phase 2, Part XLIX): the test factor cannot leak
 * into a production or default runtime.
 */
export function selectScryptParams(env: NodeJS.ProcessEnv = process.env): ScryptParams {
  const isTest = env['VITEST'] === 'true' || env['NODE_ENV'] === 'test';
  return isTest ? TEST_SCRYPT_PARAMS : PROD_SCRYPT_PARAMS;
}

const TEST_MODE = selectScryptParams() === TEST_SCRYPT_PARAMS;
const PARAMS = selectScryptParams();
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: Math.max(PARAMS.maxmem, 256 * N * r),
  });
  // Constant-time comparison: a length check alone would leak information.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
