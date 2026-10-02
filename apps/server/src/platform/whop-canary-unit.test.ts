/**
 * Whop CORE 50K canary — pure unit coverage (no DB, no HTTP).
 *
 * The provider adapter's two jobs are (1) read the verified facts out of a Whop
 * payment payload and (2) map a Whop plan to an internal product — both must be
 * deterministic, tolerant of Whop's real field shapes, and never guess. These
 * tests pin the extraction (plan/customer/amount/currency/order), the
 * decimal-dollars → integer-micros conversion, and the product-mapping seam.
 */
import { describe, expect, it } from 'vitest';
import { parseWhopEvent } from './whop.js';
import {
  dollarsToMicros,
  WhopCommerceProvider,
  type RawCommerceEvent,
} from './commerce-provider.js';
import {
  parseWhopPlanMap,
  productKeyForWhopPlan,
  whopPlanForProduct,
  WhopPlanMapError,
} from './whop-product-map.js';

/** A realistic Whop v1 payment.succeeded payload (nested resource objects). */
function whopPaymentPayload(over: Record<string, unknown> = {}) {
  return {
    id: 'msg_canary_1',
    type: 'payment.succeeded',
    api_version: 'v1',
    timestamp: '2026-10-02T12:00:00.000Z',
    account_id: 'biz_test',
    data: {
      id: 'pay_abc123',
      subtotal: 95,
      total: 95,
      amount_after_fees: 90.1,
      currency: 'usd',
      user: { id: 'user_xyz' },
      member: { id: 'mem_xyz' },
      membership: { id: 'mem_membership' },
      plan: { id: 'plan_REAL_core50k' },
      product: { id: 'prod_core' },
      metadata: { atlasOrderId: 'order-uuid-1' },
      paid_at: '2026-10-02T12:00:01.000Z',
      ...over,
    },
  };
}

describe('parseWhopEvent — verified v1 field extraction', () => {
  it('reads order, receipt, plan, customer, amount and currency from the nested payload', () => {
    const e = parseWhopEvent(whopPaymentPayload());
    expect(e.type).toBe('payment.succeeded');
    expect(e.isPaymentSuccess).toBe(true);
    expect(e.atlasOrderId).toBe('order-uuid-1');
    expect(e.receiptId).toBe('pay_abc123');
    expect(e.productId).toBe('plan_REAL_core50k'); // plan wins over product
    expect(e.customerId).toBe('user_xyz'); // user wins over member
    expect(e.amountDecimal).toBe(95); // subtotal preferred
    expect(e.currency).toBe('usd');
  });

  it('falls back to flat *_id fields and product id / total when nested ones are absent', () => {
    const e = parseWhopEvent({
      type: 'payment.succeeded',
      data: {
        id: 'pay_flat',
        total: 170,
        currency: 'USD',
        user_id: 'user_flat',
        product_id: 'prod_flat',
        metadata: { order_id: 'order-flat' },
      },
    });
    expect(e.productId).toBe('prod_flat');
    expect(e.customerId).toBe('user_flat');
    expect(e.amountDecimal).toBe(170); // total used when subtotal absent
    expect(e.atlasOrderId).toBe('order-flat');
  });

  it('returns nulls (never throws) for a malformed payload', () => {
    const e = parseWhopEvent('not an object');
    expect(e.atlasOrderId).toBeNull();
    expect(e.productId).toBeNull();
    expect(e.amountDecimal).toBeNull();
    expect(e.isPaymentSuccess).toBe(false);
  });
});

describe('dollarsToMicros — exact money conversion', () => {
  it('converts whole and fractional dollars to integer micros with rounding', () => {
    expect(dollarsToMicros(95)).toBe(95_000_000);
    expect(dollarsToMicros(6.9)).toBe(6_900_000); // absorbs 6.9*1e6 float noise
    expect(dollarsToMicros(0)).toBe(0);
    expect(dollarsToMicros(599)).toBe(599_000_000);
  });

  it('maps absent/non-finite amounts to null', () => {
    expect(dollarsToMicros(null)).toBeNull();
    expect(dollarsToMicros(Number.NaN)).toBeNull();
    expect(dollarsToMicros(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('WhopCommerceProvider.normalizeEvent — provider-neutral shape', () => {
  const provider = new WhopCommerceProvider();
  const raw = (payload: object, id = 'wh_evt_1'): RawCommerceEvent => ({
    rawBody: JSON.stringify(payload),
    headers: { 'webhook-id': id },
  });

  it('surfaces the confirmed amount (as micros), currency, plan and customer', () => {
    const n = provider.normalizeEvent(raw(whopPaymentPayload()));
    expect(n.kind).toBe('PAYMENT_SUCCEEDED');
    expect(n.atlasOrderId).toBe('order-uuid-1');
    expect(n.amountMicros).toBe(95_000_000);
    expect(n.currency).toBe('usd');
    expect(n.providerProductId).toBe('plan_REAL_core50k');
    expect(n.providerCustomerId).toBe('user_xyz');
    expect(n.providerEventId).toBe('wh_evt_1'); // from the webhook-id header
  });

  it('leaves amountMicros null when Whop asserts no amount', () => {
    const n = provider.normalizeEvent(raw({ type: 'payment.succeeded', data: { id: 'pay_x', metadata: { atlasOrderId: 'o' } } }));
    expect(n.amountMicros).toBeNull();
    expect(n.providerProductId).toBeNull();
  });
});

describe('whop-product-map — the one authoritative mapping seam', () => {
  it('parses a valid map and rejects malformed shapes (never silently empty)', () => {
    expect(parseWhopPlanMap('{"htf-core-50k":"plan_X"}')).toEqual({ 'htf-core-50k': 'plan_X' });
    expect(parseWhopPlanMap('')).toEqual({});
    expect(parseWhopPlanMap(undefined)).toEqual({});
    expect(() => parseWhopPlanMap('not json')).toThrow(WhopPlanMapError);
    expect(() => parseWhopPlanMap('[1,2,3]')).toThrow(WhopPlanMapError);
    expect(() => parseWhopPlanMap('{"k": 123}')).toThrow(WhopPlanMapError);
    expect(() => parseWhopPlanMap('{"k": ""}')).toThrow(WhopPlanMapError);
  });

  it('resolves a product to its plan with explicit-map precedence over config', () => {
    const map = parseWhopPlanMap('{"htf-core-50k":"plan_REAL"}');
    // Explicit map wins over the product config placeholder.
    expect(whopPlanForProduct('htf-core-50k', 'plan_htf_core_50k', map)).toBe('plan_REAL');
    // Falls back to the product config value when unmapped.
    expect(whopPlanForProduct('htf-core-25k', 'plan_htf_core_25k', map)).toBe('plan_htf_core_25k');
    // Null when neither names a plan.
    expect(whopPlanForProduct('htf-core-25k', null, map)).toBeNull();
  });

  it('reverse-resolves a plan id to its internal product key, or null when unknown', () => {
    const map = parseWhopPlanMap('{"htf-core-50k":"plan_REAL","htf-core-25k":"plan_25"}');
    expect(productKeyForWhopPlan('plan_REAL', map)).toBe('htf-core-50k');
    expect(productKeyForWhopPlan('plan_25', map)).toBe('htf-core-25k');
    expect(productKeyForWhopPlan('plan_UNKNOWN', map)).toBeNull();
  });
});
