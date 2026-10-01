/**
 * Owner/operator MFA: TOTP maths, at-rest sealing, enrollment lifecycle,
 * factor verification (including single-use recovery codes), and the two-step
 * login it drives. Runs against the real test database because enrollment and
 * recovery-code consumption are database invariants, not pure functions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { mfaRecoveryCodes, organizations, users } from '../db/schema.js';
import { hashPassword } from './password.js';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpCode,
  verifyTotp,
  TOTP_STEP_SECONDS,
} from './totp.js';
import { open, seal } from './secret-box.js';
import {
  activateEnrollment,
  beginEnrollment,
  disableMfa,
  MfaError,
  mfaStatus,
  regenerateRecoveryCodes,
  RECOVERY_CODE_COUNT,
  verifyFactor,
} from './mfa.js';
import { completeMfaLogin, login } from './service.js';

let db: Database;
let close: () => Promise<void>;
let orgId: string;
const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `mfa-${crypto.randomUUID()}@atlas.test`,
      passwordHash: await hashPassword('password-12chars'),
      displayName: 'MFA Test',
      organizationId: orgId,
    })
    .returning();
  createdUsers.push(u!.id);
  return u!.id;
}

beforeAll(async () => {
  const handle = createDb(
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test',
  );
  db = handle.db;
  close = async () => {
    await handle.sql.end({ timeout: 5 });
  };
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, 'atlas'));
  orgId = org!.id;
});

afterAll(async () => {
  for (const id of createdUsers) await db.delete(users).where(eq(users.id, id));
  await close();
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const s of ['a', 'hello world', 'the quick brown fox']) {
      const bytes = Buffer.from(s);
      const encoded = base32Encode(bytes);
      const decoded = base32Decode(encoded);
      expect(decoded?.toString()).toBe(s);
    }
  });

  it('tolerates lowercase, spaces and padding, and rejects junk', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret.toLowerCase())?.equals(base32Decode(secret)!)).toBe(true);
    expect(base32Decode('!!!!')).toBeNull();
  });
});

describe('TOTP', () => {
  it('accepts a freshly generated code and rejects a wrong one', () => {
    const secret = generateTotpSecret();
    const at = Date.now();
    const code = totpCode(secret, at)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code, at)).toBe(true);
    expect(verifyTotp(secret, '000000', at)).toBe(code === '000000');
  });

  it('tolerates ±1 step of clock skew but not ±2', () => {
    const secret = generateTotpSecret();
    const at = 1_700_000_000_000; // fixed instant
    const step = TOTP_STEP_SECONDS * 1000;
    const code = totpCode(secret, at)!;
    expect(verifyTotp(secret, code, at - step)).toBe(true);
    expect(verifyTotp(secret, code, at + step)).toBe(true);
    expect(verifyTotp(secret, code, at + 2 * step)).toBe(false);
    expect(verifyTotp(secret, code, at - 2 * step)).toBe(false);
  });

  it('rejects malformed codes without throwing', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false);
    expect(verifyTotp(secret, '')).toBe(false);
  });
});

describe('at-rest sealing', () => {
  it('round-trips and fails closed on tampering', () => {
    const secret = generateTotpSecret();
    const sealed = seal(secret);
    expect(sealed).not.toContain(secret);
    expect(open(sealed)).toBe(secret);
    expect(open('v1.aaa.bbb.ccc')).toBeNull();
    expect(open('garbage')).toBeNull();
    // Flip a bit in the ciphertext BYTES (not a trailing base64url character,
    // whose final char can carry insignificant padding bits that decode to the
    // same bytes — a no-op "tamper" that let this assertion pass only by luck):
    // the GCM tag must reject a genuine byte change, deterministically.
    const parts = sealed.split('.');
    const ciphertextBytes = Buffer.from(parts[3]!, 'base64url');
    ciphertextBytes[0] = (ciphertextBytes[0] ?? 0) ^ 0x01;
    parts[3] = ciphertextBytes.toString('base64url');
    expect(open(parts.join('.'))).toBeNull();
  });
});

describe('enrollment lifecycle', () => {
  let userId: string;
  beforeEach(async () => {
    userId = await makeUser();
  });

  it('is two-phase: begin does not enroll until a code is proven', async () => {
    const { secret, otpauthUri } = await beginEnrollment(db, userId);
    // The otpauth URI legitimately carries the secret to the authenticator app;
    // what must never be stored in the clear is the DATABASE column (asserted below).
    expect(otpauthUri).toContain('otpauth://totp/');
    expect(otpauthUri).toContain(`secret=${secret}`);
    const status1 = await mfaStatus(db, userId);
    expect(status1.enrolled).toBe(false);

    // The stored secret is sealed, not the plaintext.
    const [row] = await db.select({ mfaSecret: users.mfaSecret }).from(users).where(eq(users.id, userId));
    expect(row!.mfaSecret).toBeTruthy();
    expect(row!.mfaSecret).not.toBe(secret);

    await expect(activateEnrollment(db, userId, '000000')).rejects.toThrow(MfaError);
    expect((await mfaStatus(db, userId)).enrolled).toBe(false);

    const code = totpCode(secret, Date.now())!;
    const { recoveryCodes } = await activateEnrollment(db, userId, code);
    expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    const status2 = await mfaStatus(db, userId);
    expect(status2.enrolled).toBe(true);
    expect(status2.recoveryCodesRemaining).toBe(RECOVERY_CODE_COUNT);
  });

  it('refuses to begin again once enrolled', async () => {
    const { secret } = await beginEnrollment(db, userId);
    await activateEnrollment(db, userId, totpCode(secret, Date.now())!);
    await expect(beginEnrollment(db, userId)).rejects.toMatchObject({ code: 'ALREADY_ENROLLED' });
  });
});

describe('factor verification', () => {
  it('accepts a TOTP and consumes a recovery code exactly once', async () => {
    const userId = await makeUser();
    const { secret } = await beginEnrollment(db, userId);
    const { recoveryCodes } = await activateEnrollment(db, userId, totpCode(secret, Date.now())!);

    expect(await verifyFactor(db, userId, totpCode(secret, Date.now())!)).toBe('TOTP');
    expect(await verifyFactor(db, userId, 'nope')).toBeNull();

    const recovery = recoveryCodes[0]!;
    expect(await verifyFactor(db, userId, recovery)).toBe('RECOVERY');
    // Second use of the same recovery code is rejected.
    expect(await verifyFactor(db, userId, recovery)).toBeNull();
    expect((await mfaStatus(db, userId)).recoveryCodesRemaining).toBe(RECOVERY_CODE_COUNT - 1);
  });

  it('regenerating recovery codes invalidates the old set', async () => {
    const userId = await makeUser();
    const { secret } = await beginEnrollment(db, userId);
    const { recoveryCodes: first } = await activateEnrollment(db, userId, totpCode(secret, Date.now())!);
    const { recoveryCodes: second } = await regenerateRecoveryCodes(db, userId);
    expect(second).toHaveLength(RECOVERY_CODE_COUNT);
    expect(await verifyFactor(db, userId, first[0]!)).toBeNull();
    expect(await verifyFactor(db, userId, second[0]!)).toBe('RECOVERY');
  });

  it('disable clears the secret and every recovery code', async () => {
    const userId = await makeUser();
    const { secret } = await beginEnrollment(db, userId);
    await activateEnrollment(db, userId, totpCode(secret, Date.now())!);
    await disableMfa(db, userId);
    const [row] = await db.select({ mfaSecret: users.mfaSecret, enrolled: users.mfaEnrolled }).from(users).where(eq(users.id, userId));
    expect(row!.enrolled).toBe(false);
    expect(row!.mfaSecret).toBeNull();
    const codes = await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    expect(codes).toHaveLength(0);
    expect(await verifyFactor(db, userId, totpCode(secret, Date.now())!)).toBeNull();
  });
});

describe('two-step login', () => {
  it('challenges an enrolled user and completes with a valid code', async () => {
    const userId = await makeUser();
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    await db.update(users).set({ passwordHash: await hashPassword('password-12chars') }).where(eq(users.id, userId));
    const { secret } = await beginEnrollment(db, userId);
    await activateEnrollment(db, userId, totpCode(secret, Date.now())!);

    const first = await login(db, { email: u!.email, password: 'password-12chars' });
    expect('mfaRequired' in first && first.mfaRequired).toBe(true);
    if (!('mfaRequired' in first)) throw new Error('expected challenge');

    await expect(completeMfaLogin(db, first.challengeToken, '000000')).rejects.toMatchObject({ code: 'INVALID_MFA' });
    const done = await completeMfaLogin(db, first.challengeToken, totpCode(secret, Date.now())!);
    expect('accessToken' in done).toBe(true);
    expect(done.user.id).toBe(userId);
  });

  it('an un-enrolled user still logs in with password alone', async () => {
    const userId = await makeUser();
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    const result = await login(db, { email: u!.email, password: 'password-12chars' });
    expect('accessToken' in result).toBe(true);
  });

  it('rejects a garbage challenge token', async () => {
    await expect(completeMfaLogin(db, 'not-a-token', '123456')).rejects.toMatchObject({
      code: 'MFA_CHALLENGE_INVALID',
    });
  });
});
