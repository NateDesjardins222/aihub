/**
 * Money state races (Terminal Hardening V5, P0).
 *
 * The trader saw a wrong "+$8,000 on another account" and stale figures. The
 * class is: an OLD account-money response overwriting a NEWER one, or Account
 * A's late response painting Account B. These tests drive the store with
 * deliberately out-of-order responses and prove the guards hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { api, handlers } = vi.hoisted(() => ({
  api: {
    orders: vi.fn(),
    positions: vi.fn(),
    trades: vi.fn(),
    executions: vi.fn(),
    pnl: vi.fn(),
    rules: vi.fn(),
    environment: vi.fn(),
    setEnvironment: vi.fn(),
  },
  handlers: new Map<string, (data: unknown) => void>(),
}));

vi.mock('../market/stream', () => ({
  marketStream: {
    connect: vi.fn(),
    subscribeRaw: (topic: string, handler: (data: unknown) => void) => {
      handlers.set(topic, handler);
      return () => handlers.delete(topic);
    },
  },
}));
vi.mock('./api', () => ({ tradingApi: api }));
vi.mock('../audio/trading-audio', () => ({ tradingAudio: { play: vi.fn() } }));
vi.mock('./exec-latency', () => ({ execLatency: { reconciled: vi.fn() } }));

import { useTrading } from './store';

function pnlDto(accountId: string, seq: number, equityMicros: number | null = 100_000_000_000) {
  return {
    accountId,
    status: 'ACTIVE',
    startingBalanceMicros: 100_000_000_000,
    balanceMicros: 100_000_000_000,
    equityMicros,
    openPnlMicros: 0,
    realizedPnlMicros: 0,
    feesMicros: 0,
    dayPnlMicros: 0,
    drawdownFloorMicros: 98_000_000_000,
    remainingDrawdownMicros: 2_000_000_000,
    profitTargetProgressMicros: 0,
    profitTargetMicros: 0,
    openContracts: 0,
    maxContracts: 10,
    marked: true,
    unmarkable: [],
    seq,
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Attach an account and let its initial reads settle so the seq cursor is set. */
async function attachSettled(accountId: string, seq = 0) {
  api.pnl.mockResolvedValue(pnlDto(accountId, seq));
  api.rules.mockResolvedValue({ status: null });
  useTrading.getState().attach(accountId);
  await useTrading.getState().refresh();
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  api.orders.mockResolvedValue({ orders: [] });
  api.positions.mockResolvedValue({ positions: [] });
  api.trades.mockResolvedValue({ trades: [] });
  api.executions.mockResolvedValue({ executions: [] });
  api.environment.mockResolvedValue({ environment: null, depthAwareAvailable: false });
  api.rules.mockResolvedValue({ status: null });
  useTrading.setState({ accountId: null, pnl: null, rules: null, ruleBook: null } as never);
});
afterEach(() => handlers.clear());

describe('money state races', () => {
  it('a stale REST pnl (older seq) never overwrites a newer live figure — no phantom money', async () => {
    await attachSettled('A', 0);
    // A newer live frame lands (seq 5): equity 100k.
    handlers.get('acct.A.pnl')?.(pnlDto('A', 5, 100_000_000_000));
    expect(useTrading.getState().pnl?.equityMicros).toBe(100_000_000_000);
    // A slow REST /pnl (seq 3) with a huge stale figure returns — must be rejected.
    api.pnl.mockResolvedValueOnce(pnlDto('A', 3, 999_000_000_000));
    await useTrading.getState().readAll('A');
    expect(useTrading.getState().pnl?.equityMicros).toBe(100_000_000_000);
  });

  it('a newer REST pnl applies, then an older WS frame is dropped', async () => {
    await attachSettled('A', 0);
    api.pnl.mockResolvedValueOnce(pnlDto('A', 10, 100_000_000_000));
    await useTrading.getState().readAll('A');
    expect(useTrading.getState().pnl?.seq).toBe(10);
    handlers.get('acct.A.pnl')?.(pnlDto('A', 7, 55_000_000_000)); // older
    expect(useTrading.getState().pnl?.equityMicros).toBe(100_000_000_000);
  });

  it("Account A's late loadRules response never paints Account B (+$8k bleed)", async () => {
    useTrading.setState({ accountId: 'A', ruleBook: null, rules: null } as never);
    const dA = deferred<{ status: unknown }>();
    api.rules.mockReturnValueOnce(dA.promise);
    const p = useTrading.getState().loadRules(); // captures 'A'
    useTrading.setState({ accountId: 'B' } as never); // trader switches
    dA.resolve({ status: { status: 'FAILED', equityMicros: 8_000_000_000 } });
    await p;
    expect(useTrading.getState().ruleBook).toBeNull();
    expect(useTrading.getState().rules).toBeNull();
  });

  it('a WS frame for Account A is dropped once Account B is selected', async () => {
    await attachSettled('A', 0);
    const aHandler = handlers.get('acct.A.pnl')!;
    await attachSettled('B', 0); // switch resets pnl for B
    const bPnl = useTrading.getState().pnl;
    aHandler(pnlDto('A', 99, 42_000_000_000)); // A's stray frame
    expect(useTrading.getState().pnl).toBe(bPnl); // unchanged — A did not paint B
    expect(useTrading.getState().pnl?.accountId).not.toBe('A');
  });
});
