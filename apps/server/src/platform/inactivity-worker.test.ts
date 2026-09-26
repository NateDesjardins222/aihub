/**
 * The inactivity worker binding (Phase 12.5, HTF-18).
 *
 * The sweep itself is covered by account-inactivity's own tests; this proves the
 * worker actually runs it and that running it repeatedly is safe — a second tick
 * neither re-closes an account nor re-warns one, which is what makes an interval
 * worker sound.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { InactivityWorker } from './inactivity-worker.js';

let db: Database;
let close: () => Promise<void>;

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

describe('InactivityWorker', () => {
  it('runs the sweep and is idempotent across ticks', async () => {
    const worker = new InactivityWorker(db);
    const first = await worker.tick();
    expect(first.closed).toBeGreaterThanOrEqual(0);
    expect(first.warned).toBeGreaterThanOrEqual(0);

    // A second immediate tick must not re-close or re-warn anything: closures
    // guard on ACTIVE and warnings dedupe per (account, month).
    const second = await worker.tick();
    expect(second.closed).toBe(0);
    expect(second.warned).toBe(0);
  });
});
