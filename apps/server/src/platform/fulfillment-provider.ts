/**
 * Fulfillment provider abstraction (Milestone 6).
 *
 * The physical-order domain talks to this interface, never to Prodigi directly.
 * MockFulfillmentProvider is the deterministic dev/test default. The Prodigi seam
 * is provider-ready but DISABLED unless explicitly configured
 * (PRODIGI_ENABLED=true + PRODIGI_API_KEY): it never fabricates a successful
 * production order and never spends money by default. Production activation is a
 * later controlled deployment step.
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';

export interface FulfillmentAddress {
  readonly name: string;
  readonly line1: string;
  readonly line2?: string | null;
  readonly city: string;
  readonly region?: string | null;
  readonly postalCode: string;
  readonly country: string; // ISO-2
}

export interface QuoteInput {
  readonly sku: string;
  readonly quantity: number;
  readonly address: FulfillmentAddress;
}
export interface Quote {
  readonly itemCostMicros: number;
  readonly shippingMicros: number;
  readonly totalMicros: number;
  readonly currency: string;
}

export interface CreateOrderInput {
  /** Our order id — the provider order is idempotent on it. */
  readonly idempotencyKey: string;
  readonly sku: string;
  readonly quantity: number;
  readonly address: FulfillmentAddress;
  /** A URL or key the provider can fetch the immutable print artifact from. */
  readonly assetRef: string;
}
export interface ProviderOrder {
  readonly providerOrderId: string;
  readonly status: 'ACCEPTED' | 'IN_PRODUCTION' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'FAILED';
  readonly quote?: Quote;
}
export interface Tracking {
  readonly carrier: string | null;
  readonly trackingNumber: string | null;
  readonly trackingUrl: string | null;
  readonly status: 'SHIPPED' | 'DELIVERED' | 'IN_TRANSIT' | 'UNKNOWN';
}

export interface FulfillmentProvider {
  readonly name: 'MOCK' | 'PRODIGI';
  isConfigured(): boolean;
  quote(input: QuoteInput): Promise<Quote>;
  validateProduct(sku: string): Promise<boolean>;
  createOrder(input: CreateOrderInput): Promise<ProviderOrder>;
  getOrder(providerOrderId: string): Promise<ProviderOrder | null>;
  getTracking(providerOrderId: string): Promise<Tracking | null>;
}

export class FulfillmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'FulfillmentError';
  }
}

/** SKUs this build knows how to fulfill. Immutable mapping. */
export const KNOWN_SKUS = new Set<string>(['GLOBAL-CFP-11X14']);

/**
 * Deterministic mock provider for dev + tests. Quotes ≈ $62 delivered (the
 * observed working assumption — display/planning only, never a guaranteed cost),
 * creates a stable provider order id from the idempotency key, and reports mock
 * tracking. No network, no money.
 */
export class MockFulfillmentProvider implements FulfillmentProvider {
  readonly name = 'MOCK' as const;
  isConfigured(): boolean { return true; }
  async validateProduct(sku: string): Promise<boolean> { return KNOWN_SKUS.has(sku); }
  async quote(input: QuoteInput): Promise<Quote> {
    const itemCostMicros = 52_000_000 * input.quantity; // ~$52 item
    const shippingMicros = 10_000_000; // ~$10 ship
    return { itemCostMicros, shippingMicros, totalMicros: itemCostMicros + shippingMicros, currency: 'USD' };
  }
  async createOrder(input: CreateOrderInput): Promise<ProviderOrder> {
    if (!KNOWN_SKUS.has(input.sku)) throw new FulfillmentError('SKU_UNAVAILABLE', 'Unknown SKU.');
    // Idempotent: the same idempotency key always yields the same provider id.
    const providerOrderId = `mock_${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16)}`;
    return { providerOrderId, status: 'ACCEPTED', quote: await this.quote({ sku: input.sku, quantity: input.quantity, address: input.address }) };
  }
  async getOrder(providerOrderId: string): Promise<ProviderOrder | null> {
    return { providerOrderId, status: 'IN_PRODUCTION' };
  }
  async getTracking(providerOrderId: string): Promise<Tracking | null> {
    return { carrier: 'MockPost', trackingNumber: `TRK${providerOrderId.slice(-8).toUpperCase()}`, trackingUrl: null, status: 'SHIPPED' };
  }
}

/**
 * Prodigi seam — provider-ready, DISABLED by default. Every operation refuses
 * unless the provider is explicitly enabled AND configured, so a misconfiguration
 * fails loudly and no real manufacturing order is ever sent from this build.
 * Wire the real Prodigi API (GLOBAL-CFP-11X14, order + webhook) here in a later
 * controlled step, using current official Prodigi documentation.
 */
export class ProdigiFulfillmentProvider implements FulfillmentProvider {
  readonly name = 'PRODIGI' as const;
  isConfigured(): boolean {
    const e = env();
    return e.PRODIGI_ENABLED === true && typeof e.PRODIGI_API_KEY === 'string' && e.PRODIGI_API_KEY.length > 0;
  }
  private guard(): void {
    if (!this.isConfigured()) throw new FulfillmentError('PRODIGI_DISABLED', 'Prodigi fulfillment is disabled in this build.');
  }
  async validateProduct(): Promise<boolean> { this.guard(); return false; }
  async quote(): Promise<Quote> { this.guard(); throw new FulfillmentError('PRODIGI_DISABLED', 'not implemented'); }
  async createOrder(): Promise<ProviderOrder> { this.guard(); throw new FulfillmentError('PRODIGI_DISABLED', 'not implemented'); }
  async getOrder(): Promise<ProviderOrder | null> { this.guard(); return null; }
  async getTracking(): Promise<Tracking | null> { this.guard(); return null; }
}

let cached: FulfillmentProvider | null = null;
/**
 * The active fulfillment provider. Prodigi only when explicitly enabled AND
 * configured; otherwise the deterministic mock. Cached; overridable in tests.
 */
export function fulfillmentProvider(): FulfillmentProvider {
  if (cached) return cached;
  const prodigi = new ProdigiFulfillmentProvider();
  cached = prodigi.isConfigured() ? prodigi : new MockFulfillmentProvider();
  return cached;
}
export function setFulfillmentProviderForTest(p: FulfillmentProvider | null): void {
  cached = p;
}
