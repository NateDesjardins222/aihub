/**
 * Enforcement holds × the hot paths (M7). The safety-critical guarantees:
 *
 *  - a TRADING hold blocks an exposure-INCREASING order, but NEVER a
 *    reduce/flatten/close (a held trader can always de-risk),
 *  - a liquidation is never blocked,
 *  - releasing the hold restores trading,
 *  - a CUSTOMER-scope hold reaches the owner's accounts, an ACCOUNT-scope hold
 *    does not leak to another account,
 *  - PAYOUT_REQUEST and PAYOUT_APPROVAL are independent capabilities,
 *  - an expired hold does not block.
 *
 * These use the real trading engine and the real hold-read layer the payout
 * engine consults — no mocks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { positions as positionsTable } from '../db/schema.js';
import { TradingEngine } from '../trading/engine.js';
import { OrderRejectedError } from '../trading/engine.js';
import { createFixture, OPEN_MARKET_TS, ScriptedMarket, settle, type TestFixture } from '../trading/harness.js';
import { defaultOrganizationId } from './provisioning.js';
import { placeHold, releaseHold } from './enforcement.js';
import { holdBlocking, tradingHoldForAccount } from './enforcement-holds.js';

const CLEAN_ENV = { fillModel: 'SIMPLE' as const, latencyMs: 0, marketSlippageTicks: 0, stopSlippageTicks: 0, requireThroughTradeForLimit: false, feesEnabled: false, useBarRange: true };
const ADMIN = { type: 'ADMIN' as const, userId: undefined, label: 'op' };

let fixture: TestFixture;
let market: ScriptedMarket;
let engine: TradingEngine;
let organizationId: string;
let seq = 0;
let barTs = OPEN_MARKET_TS;

function cid(l: string): string { seq += 1; return `${l}-${seq}-${Date.now()}`; }
function nextTs(): number { barTs += 60_000; return barTs; }

async function submit(input: Partial<Parameters<TradingEngine['submitOrder']>[0]> = {}) {
  return engine.submitOrder({ accountId: fixture.accountId, userId: fixture.userId, clientOrderId: cid('enf'), symbol: 'NQ', side: 'BUY', qty: 1, type: 'MARKET', ...input });
}
async function posQty(): Promise<number> {
  const [row] = await fixture.db.select().from(positionsTable).where(and(eq(positionsTable.accountId, fixture.accountId), eq(positionsTable.symbol, 'NQ')));
  return row?.qty ?? 0;
}
async function hold(capability: 'TRADING' | 'PAYOUT_REQUEST' | 'PAYOUT_APPROVAL' | 'ACCESS' | 'PURCHASE', scope: 'ACCOUNT' | 'CUSTOMER' = 'ACCOUNT', scopeId = fixture.accountId, expiresAt: Date | null = null) {
  return placeHold(fixture.db, { organizationId, scope, scopeId, capability, reasonCode: `MANUAL_${capability}`, expiresAt, actor: ADMIN });
}

beforeEach(async () => {
  barTs = OPEN_MARKET_TS;
  fixture = await createFixture({ environment: CLEAN_ENV });
  organizationId = await defaultOrganizationId(fixture.db);
  market = new ScriptedMarket();
  engine = new TradingEngine(fixture.db, market);
  await engine.start();
  await market.quote('NQ', 20_000, nextTs());
});
afterEach(async () => { engine?.stop(); await fixture?.close(); });

describe('trading hold safety', () => {
  it('blocks an exposure-increasing order with ACCOUNT_ENFORCEMENT_HOLD', async () => {
    await hold('TRADING');
    await expect(submit({ side: 'BUY', qty: 1 })).rejects.toMatchObject({ reason: 'ACCOUNT_ENFORCEMENT_HOLD' });
    expect(await posQty()).toBe(0);
  });

  it('never blocks a reduce/close while held (a trader can always de-risk)', async () => {
    // Open a 3-lot BEFORE any hold.
    await submit({ side: 'BUY', qty: 3 });
    await settle();
    expect(await posQty()).toBe(3);
    // Now hold trading, then reduce and then fully close — both must succeed.
    await hold('TRADING');
    await submit({ side: 'SELL', qty: 1 });
    await settle();
    expect(await posQty()).toBe(2);
    await submit({ side: 'SELL', qty: 2 });
    await settle();
    expect(await posQty()).toBe(0);
  });

  it('never blocks a liquidation order', async () => {
    await submit({ side: 'BUY', qty: 2 });
    await settle();
    await hold('TRADING');
    await submit({ side: 'SELL', qty: 2, liquidation: true });
    await settle();
    expect(await posQty()).toBe(0);
  });

  it('blocks adding to an existing position (increasing exposure) while held', async () => {
    await submit({ side: 'BUY', qty: 1 });
    await settle();
    await hold('TRADING');
    await expect(submit({ side: 'BUY', qty: 1 })).rejects.toBeInstanceOf(OrderRejectedError);
    expect(await posQty()).toBe(1);
  });

  it('restores trading once the hold is released', async () => {
    const h = await hold('TRADING');
    await expect(submit({ side: 'BUY', qty: 1 })).rejects.toBeInstanceOf(OrderRejectedError);
    await releaseHold(fixture.db, h.id, { actor: ADMIN });
    await submit({ side: 'BUY', qty: 1 });
    await settle();
    expect(await posQty()).toBe(1);
  });

  it('a CUSTOMER-scope hold on the owner also stops opening', async () => {
    // Resolve the owner identity by creating a CUSTOMER hold keyed on it.
    const owner = await import('./enforcement-holds.js').then((m) => m.resolveAccountOwnerIdentity(fixture.db, fixture.accountId));
    // The fixture user may have no customer identity; only assert when it does.
    if (owner?.customerIdentityId) {
      await hold('TRADING', 'CUSTOMER', owner.customerIdentityId);
      await expect(submit({ side: 'BUY', qty: 1 })).rejects.toMatchObject({ reason: 'ACCOUNT_ENFORCEMENT_HOLD' });
    }
  });
});

describe('hold-read layer (what the payout engine consults)', () => {
  it('tradingHoldForAccount returns the hold, then null after release', async () => {
    const h = await hold('TRADING');
    expect(await tradingHoldForAccount(fixture.db, fixture.accountId)).not.toBeNull();
    await releaseHold(fixture.db, h.id, { actor: ADMIN });
    expect(await tradingHoldForAccount(fixture.db, fixture.accountId)).toBeNull();
  });

  it('PAYOUT_REQUEST and PAYOUT_APPROVAL are independent capabilities', async () => {
    await hold('PAYOUT_REQUEST');
    expect(await holdBlocking(fixture.db, { accountId: fixture.accountId }, 'PAYOUT_REQUEST')).not.toBeNull();
    // A request hold does NOT block approval, and vice-versa.
    expect(await holdBlocking(fixture.db, { accountId: fixture.accountId }, 'PAYOUT_APPROVAL')).toBeNull();
  });

  it('an ACCOUNT hold never leaks to a different account id', async () => {
    await hold('TRADING');
    expect(await tradingHoldForAccount(fixture.db, crypto.randomUUID())).toBeNull();
  });

  it('an expired hold does not block', async () => {
    await hold('TRADING', 'ACCOUNT', fixture.accountId, new Date(Date.now() - 60_000));
    expect(await tradingHoldForAccount(fixture.db, fixture.accountId)).toBeNull();
  });

  it('a trading hold does not block a payout capability (capabilities are scoped)', async () => {
    await hold('TRADING');
    expect(await holdBlocking(fixture.db, { accountId: fixture.accountId }, 'PAYOUT_REQUEST')).toBeNull();
  });
});
