/**
 * Kill-switch ENFORCEMENT (Phase 7 — HTF-10 partial).
 *
 * Before Phase 7 the owner console could engage seven kill switches — writing a
 * CRITICAL audit event and an owner alert — but only two of them
 * (`MAINTENANCE_MODE`, `DISABLE_NEW_ORDERS`) actually stopped anything. Engaging
 * "disable payouts" or "disable new purchases" did NOTHING: a switch you can't
 * trust is worse than none.
 *
 * This suite proves the five money/lifecycle switches now enforce at their
 * authoritative server chokepoints. `assertNotEngaged` is the FIRST line of each
 * chokepoint, so an engaged switch rejects with `KILL_SWITCH_ENGAGED` (423)
 * before any other work — which is exactly what we assert. Releasing the switch
 * removes the block (the call then proceeds to its own validation).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { SYSTEM_ACTOR } from './actor.js';
import {
  KILL_SWITCHES,
  engageKillSwitch,
  isEngaged,
  releaseKillSwitch,
  type KillSwitchKey,
} from './kill-switches.js';
import { createPendingOrder } from './commerce.js';
import { provisionAccount } from './provisioning.js';
import { requestPayout } from './payouts.js';
import { submitPayable } from './payout-operations.js';
import { externalExecutionGate } from '../execution/safety-gate.js';

let db: ReturnType<typeof getDb>['db'];

async function rejectCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.code : `NON_API:${(err as Error).message}`;
  }
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  db = getDb().db;
});

afterEach(async () => {
  // Leave no switch engaged for other suites.
  for (const key of KILL_SWITCHES) {
    if (await isEngaged(db, key)) await releaseKillSwitch(db, key, 'test cleanup', SYSTEM_ACTOR);
  }
});

afterAll(async () => {
  for (const key of KILL_SWITCHES) {
    if (await isEngaged(db, key)) await releaseKillSwitch(db, key, 'test cleanup', SYSTEM_ACTOR);
  }
});

const dummyOrg = '00000000-0000-0000-0000-000000000000';
const dummyId = '00000000-0000-0000-0000-000000000001';

describe('kill-switch enforcement at chokepoints', () => {
  it('DISABLE_NEW_PURCHASES blocks createPendingOrder', async () => {
    await engageKillSwitch(db, 'DISABLE_NEW_PURCHASES', 'incident test', SYSTEM_ACTOR);
    const code = await rejectCode(() =>
      createPendingOrder(db, { organizationId: dummyOrg, userId: dummyId, productVersionId: dummyId, source: 'MANUAL' } as never),
    );
    expect(code).toBe('KILL_SWITCH_ENGAGED');

    await releaseKillSwitch(db, 'DISABLE_NEW_PURCHASES', 'cleared', SYSTEM_ACTOR);
    const after = await rejectCode(() =>
      createPendingOrder(db, { organizationId: dummyOrg, userId: dummyId, productVersionId: dummyId, source: 'MANUAL' } as never),
    );
    // Released: the switch no longer blocks (the call fails on its own validation instead).
    expect(after).not.toBe('KILL_SWITCH_ENGAGED');
  });

  it('DISABLE_PROVISIONING blocks provisionAccount', async () => {
    await engageKillSwitch(db, 'DISABLE_PROVISIONING', 'incident test', SYSTEM_ACTOR);
    const code = await rejectCode(() =>
      provisionAccount(db, { organizationId: dummyOrg, userId: dummyId, profileVersionId: dummyId } as never),
    );
    expect(code).toBe('KILL_SWITCH_ENGAGED');

    await releaseKillSwitch(db, 'DISABLE_PROVISIONING', 'cleared', SYSTEM_ACTOR);
    const after = await rejectCode(() =>
      provisionAccount(db, { organizationId: dummyOrg, userId: dummyId, profileVersionId: dummyId } as never),
    );
    expect(after).not.toBe('KILL_SWITCH_ENGAGED');
  });

  it('DISABLE_NEW_PAYOUT_REQUESTS blocks requestPayout', async () => {
    await engageKillSwitch(db, 'DISABLE_NEW_PAYOUT_REQUESTS', 'incident test', SYSTEM_ACTOR);
    const code = await rejectCode(() =>
      requestPayout(db, { accountId: dummyId, amountMicros: 1, actor: SYSTEM_ACTOR } as never),
    );
    expect(code).toBe('KILL_SWITCH_ENGAGED');

    await releaseKillSwitch(db, 'DISABLE_NEW_PAYOUT_REQUESTS', 'cleared', SYSTEM_ACTOR);
    const after = await rejectCode(() =>
      requestPayout(db, { accountId: dummyId, amountMicros: 1, actor: SYSTEM_ACTOR } as never),
    );
    expect(after).not.toBe('KILL_SWITCH_ENGAGED');
  });

  it('DISABLE_PAYOUT_SUBMISSION blocks submitPayable', async () => {
    await engageKillSwitch(db, 'DISABLE_PAYOUT_SUBMISSION', 'incident test', SYSTEM_ACTOR);
    const code = await rejectCode(() => submitPayable(db, dummyId));
    expect(code).toBe('KILL_SWITCH_ENGAGED');

    await releaseKillSwitch(db, 'DISABLE_PAYOUT_SUBMISSION', 'cleared', SYSTEM_ACTOR);
    const after = await rejectCode(() => submitPayable(db, dummyId));
    expect(after).not.toBe('KILL_SWITCH_ENGAGED');
  });

  it('DISABLE_EXTERNAL_EXECUTION blocks the external safety gate (SIMULATION unaffected)', () => {
    // SIMULATION always passes, even with the switch flagged.
    const sim = externalExecutionGate({
      mapping: { executionMode: 'SIMULATION', status: 'ACTIVE' } as never,
      registry: {} as never, root: 'NQ', contractCode: null, marketNow: Date.now(),
      freshness: { state: 'FRESH', blocksOrderEntry: false }, killSwitchEngaged: true,
    });
    expect(sim.allow).toBe(true);

    // An EXTERNAL order is refused the moment the switch is engaged.
    const ext = externalExecutionGate({
      mapping: { executionMode: 'EXTERNAL_LIVE', status: 'ACTIVE' } as never,
      registry: {} as never, root: 'NQ', contractCode: null, marketNow: Date.now(),
      freshness: { state: 'FRESH', blocksOrderEntry: false }, killSwitchEngaged: true,
    });
    expect(ext.allow).toBe(false);
    if (!ext.allow) expect(ext.reason).toBe('EXECUTION_PROVIDER_UNAVAILABLE');
  });

  it('engage/release wiring round-trips for every switch', async () => {
    for (const key of KILL_SWITCHES as readonly KillSwitchKey[]) {
      await engageKillSwitch(db, key, 'round-trip', SYSTEM_ACTOR);
      expect(await isEngaged(db, key)).toBe(true);
      await releaseKillSwitch(db, key, 'round-trip', SYSTEM_ACTOR);
      expect(await isEngaged(db, key)).toBe(false);
    }
  });
});
