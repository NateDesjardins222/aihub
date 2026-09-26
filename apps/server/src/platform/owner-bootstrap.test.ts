/**
 * Production owner bootstrap: the one safe path to the first operator.
 *
 * The happy path (creating the very first SUPER_ADMIN) is exercised inside a
 * transaction that is rolled back, so the shared test database — which is seeded
 * with an owner — is never mutated and other suites in the monolithic run are
 * unaffected. The refusal paths run directly against the seeded database, where
 * an owner already exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  bootstrapOwner,
  ownerExists,
  OwnerBootstrapError,
  MIN_OWNER_PASSWORD_LENGTH,
} from './owner-bootstrap.js';

let db: Database;
let close: () => Promise<void>;

class Rollback extends Error {}

beforeAll(async () => {
  const handle = createDb(
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test',
  );
  db = handle.db;
  close = async () => {
    await handle.sql.end({ timeout: 5 });
  };
});

afterAll(async () => {
  await close();
});

describe('owner bootstrap — refusals (seeded database already has an owner)', () => {
  it('reports that an owner exists', async () => {
    expect(await ownerExists(db)).toBe(true);
  });

  it('refuses to create a second owner', async () => {
    await expect(
      bootstrapOwner(db, { email: `boot-${crypto.randomUUID()}@atlas.test`, password: 'a-strong-password-123' }),
    ).rejects.toMatchObject({ code: 'OWNER_EXISTS' });
  });

  it('rejects a weak password before anything else', async () => {
    await expect(
      bootstrapOwner(db, { email: `boot-${crypto.randomUUID()}@atlas.test`, password: 'short' }),
    ).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    expect('x'.repeat(MIN_OWNER_PASSWORD_LENGTH - 1).length).toBeLessThan(MIN_OWNER_PASSWORD_LENGTH);
  });

  it('rejects an invalid email', async () => {
    await expect(
      bootstrapOwner(db, { email: 'not-an-email', password: 'a-strong-password-123' }),
    ).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
  });
});

describe('owner bootstrap — first operator (rolled back)', () => {
  it('creates the first SUPER_ADMIN on a database with none, then refuses a second', async () => {
    const email = `first-owner-${crypto.randomUUID()}@atlas.test`;
    await expect(
      db.transaction(async (tx) => {
        const t = tx as unknown as Database;
        // Simulate a fresh deployment: no SUPER_ADMIN yet (rolled back after).
        await tx.update(users).set({ role: 'ADMIN' }).where(eq(users.role, 'SUPER_ADMIN'));
        expect(await ownerExists(t)).toBe(false);

        const result = await bootstrapOwner(t, { email, password: 'a-strong-password-123', displayName: 'First Owner' });
        expect(result.email).toBe(email);

        const [created] = await tx
          .select({ role: users.role, isAdmin: users.isAdmin, status: users.status })
          .from(users)
          .where(eq(users.id, result.userId));
        expect(created!.role).toBe('SUPER_ADMIN');
        expect(created!.isAdmin).toBe(true);
        expect(created!.status).toBe('ACTIVE');
        expect(await ownerExists(t)).toBe(true);

        // Now that one exists, a second bootstrap is refused.
        await expect(
          bootstrapOwner(t, { email: `second-${crypto.randomUUID()}@atlas.test`, password: 'a-strong-password-123' }),
        ).rejects.toMatchObject({ code: 'OWNER_EXISTS' });

        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    // The rolled-back owner is gone; the seeded database is untouched.
    const leaked = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(leaked).toHaveLength(0);
  });
});
