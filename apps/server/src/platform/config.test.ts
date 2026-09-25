/**
 * Feature flags + kill switches (M10-F). Flags carry optimistic-concurrency
 * conflict detection; kill switches are audited and gate NEW exposure only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { defaultOrganizationId } from './provisioning.js';
import type { Actor } from './actor.js';
import { isEnabled, listFlags, setFlag } from './feature-flags.js';
import { assertNotEngaged, engageKillSwitch, isEngaged, isKillSwitchKey, KILL_SWITCHES, listKillSwitches, releaseKillSwitch } from './kill-switches.js';

const ACTOR: Actor = { type: 'ADMIN', label: 'cfg@test', userId: null };
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let organizationId: string;
let seq = 0;
const flagKey = () => { seq += 1; return `M10F_FLAG_${seq}_${Math.floor(Math.random() * 1e6)}`; };

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  organizationId = await defaultOrganizationId(db);
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('feature flags', () => {
  it('creates, reads and toggles a flag', async () => {
    const key = flagKey();
    expect(await isEnabled(db, key)).toBe(false);
    await setFlag(db, { organizationId, key, enabled: true, description: 'test flag', actor: ACTOR });
    expect(await isEnabled(db, key)).toBe(true);
    await setFlag(db, { organizationId, key, enabled: false, actor: ACTOR });
    expect(await isEnabled(db, key)).toBe(false);
    expect((await listFlags(db)).some((f) => f.key === key)).toBe(true);
  });

  it('detects a concurrent-edit conflict via expectedUpdatedAt', async () => {
    const key = flagKey();
    const first = await setFlag(db, { organizationId, key, enabled: true, actor: ACTOR });
    // A stale editor still holds the old timestamp; a fresh edit lands first.
    await setFlag(db, { organizationId, key, enabled: false, actor: ACTOR });
    await expect(setFlag(db, { organizationId, key, enabled: true, actor: ACTOR, expectedUpdatedAt: first.updatedAt.toISOString() })).rejects.toThrow();
  });

  it('a matching expectedUpdatedAt succeeds', async () => {
    const key = flagKey();
    const first = await setFlag(db, { organizationId, key, enabled: true, actor: ACTOR });
    const ok = await setFlag(db, { organizationId, key, enabled: false, actor: ACTOR, expectedUpdatedAt: first.updatedAt.toISOString() });
    expect(ok.enabled).toBe(false);
  });
});

describe('kill switches', () => {
  it('every known switch is present in the listing, defaulting to not-engaged', async () => {
    const list = await listKillSwitches(db);
    for (const key of KILL_SWITCHES) expect(list.some((s) => s.key === key)).toBe(true);
  });

  it('engage/release round-trips and audits, and requires a reason to engage', async () => {
    await expect(engageKillSwitch(db, 'DISABLE_NEW_ORDERS', '', ACTOR, organizationId)).rejects.toThrow();
    await engageKillSwitch(db, 'DISABLE_NEW_ORDERS', 'incident HT-INC test', ACTOR, organizationId);
    expect(await isEngaged(db, 'DISABLE_NEW_ORDERS')).toBe(true);
    await expect(assertNotEngaged(db, 'DISABLE_NEW_ORDERS')).rejects.toThrow();
    await releaseKillSwitch(db, 'DISABLE_NEW_ORDERS', 'incident resolved', ACTOR, organizationId);
    expect(await isEngaged(db, 'DISABLE_NEW_ORDERS')).toBe(false);
    await expect(assertNotEngaged(db, 'DISABLE_NEW_ORDERS')).resolves.toBeUndefined();
  });

  it('isKillSwitchKey validates the catalog', () => {
    expect(isKillSwitchKey('MAINTENANCE_MODE')).toBe(true);
    expect(isKillSwitchKey('NONSENSE')).toBe(false);
  });

  it('engaging writes a kill_switch.engaged audit event', async () => {
    await engageKillSwitch(db, 'MAINTENANCE_MODE', 'audit test', ACTOR, organizationId);
    const { queryOpsEvents } = await import('./ops-events.js');
    const sec = await queryOpsEvents(db, organizationId, { limit: 200 });
    expect(sec.some((e) => e.type === 'kill_switch.engaged')).toBe(true);
    await releaseKillSwitch(db, 'MAINTENANCE_MODE', 'done', ACTOR, organizationId);
  });
});
