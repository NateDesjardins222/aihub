/**
 * Rithmic reconciliation — deterministic tests (Milestone 9).
 *
 * Proves MATCHED / MISMATCH / UNKNOWN / REQUIRES_REVIEW verdicts for orders and
 * positions, that Atlas-behind-provider is safely auto-resolvable while a
 * provider-only order is REQUIRES_REVIEW (never invented), and that a lost-ack
 * order (no provider id) is UNKNOWN — reconcile before any resubmit.
 */
import { describe, expect, it } from 'vitest';
import { reconcileOrders, reconcilePositions, summarize, type AtlasOrderView, type AtlasPositionView } from './reconcile.js';
import type { ExternalOrderSnapshot, ExternalPositionSnapshot } from '../../execution/external-provider.js';

const aOrder = (o: Partial<AtlasOrderView>): AtlasOrderView => ({ atlasOrderId: 'a', providerOrderId: 'BK', state: 'ACKNOWLEDGED', filledQty: 0, ...o });
const pOrder = (o: Partial<ExternalOrderSnapshot>): ExternalOrderSnapshot => ({ providerOrderId: 'BK', symbol: 'NQ', side: 'BUY', qty: 1, filledQty: 0, state: 'ACKNOWLEDGED', ...o });

describe('order reconciliation', () => {
  it('MATCHED when Atlas and provider agree', () => {
    const f = reconcileOrders([aOrder({})], [pOrder({})]);
    expect(f[0]!.verdict).toBe('MATCHED');
  });

  it('MISMATCH + auto-resolvable when Atlas is behind the provider (forward transition)', () => {
    const f = reconcileOrders([aOrder({ state: 'ACKNOWLEDGED', filledQty: 0 })], [pOrder({ state: 'FILLED', filledQty: 1 })]);
    expect(f[0]!.verdict).toBe('MISMATCH');
    expect(f[0]!.autoResolvable).toBe(true);
  });

  it('REQUIRES_REVIEW when the provider has an order Atlas never recorded (never invented)', () => {
    const f = reconcileOrders([], [pOrder({ providerOrderId: 'GHOST' })]);
    expect(f[0]!.verdict).toBe('REQUIRES_REVIEW');
    expect(f[0]!.autoResolvable).toBe(false);
  });

  it('UNKNOWN for a lost-ack Atlas order with no provider id — reconcile before resubmit', () => {
    const f = reconcileOrders([aOrder({ atlasOrderId: 'a2', providerOrderId: null, state: 'UNKNOWN' })], []);
    expect(f[0]!.verdict).toBe('UNKNOWN');
    expect(f[0]!.autoResolvable).toBe(false);
  });

  it('MISMATCH (not auto) when Atlas shows open but the provider has no such working order', () => {
    const f = reconcileOrders([aOrder({ providerOrderId: 'BK', state: 'ACKNOWLEDGED' })], []);
    expect(f[0]!.verdict).toBe('MISMATCH');
    expect(f[0]!.autoResolvable).toBe(false);
  });
});

describe('position reconciliation', () => {
  const aPos = (s: string, q: number): AtlasPositionView => ({ symbol: s, netQty: q });
  const pPos = (s: string, q: number): ExternalPositionSnapshot => ({ symbol: s, contractCode: s, netQty: q, avgPrice: null });

  it('MATCHED on equal net quantity', () => {
    expect(reconcilePositions([aPos('NQ', 2)], [pPos('NQ', 2)])[0]!.verdict).toBe('MATCHED');
  });
  it('MISMATCH on differing net quantity (never auto-invented)', () => {
    const f = reconcilePositions([aPos('NQ', 2)], [pPos('NQ', 1)]);
    expect(f[0]!.verdict).toBe('MISMATCH');
    expect(f[0]!.autoResolvable).toBe(false);
  });
  it('reports a provider-only position as a mismatch', () => {
    const f = reconcilePositions([], [pPos('ES', 3)]);
    expect(f[0]!.verdict).toBe('MISMATCH');
  });
});

describe('summary', () => {
  it('counts verdicts and auto-resolvable findings', () => {
    const f = reconcileOrders(
      [aOrder({ atlasOrderId: 'm', providerOrderId: 'BK1' }), aOrder({ atlasOrderId: 'b', providerOrderId: 'BK2', state: 'ACKNOWLEDGED' })],
      [pOrder({ providerOrderId: 'BK1' }), pOrder({ providerOrderId: 'BK2', state: 'FILLED', filledQty: 1 })],
    );
    const s = summarize(f);
    expect(s.matched).toBe(1);
    expect(s.mismatch).toBe(1);
    expect(s.autoResolvable).toBe(1);
  });
});
