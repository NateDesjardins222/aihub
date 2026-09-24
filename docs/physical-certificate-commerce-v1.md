# Physical Certificate Commerce (Milestone 6)

Optional physical framed certificate ordering, plus the 100K manual plaque. No real
manufacturing order is submitted, no real customer is charged, and production
fulfillment is **disabled by default** in this milestone.

## The product

- **Premium Framed Certificate**, 11×14, retail **$99.99 USD**.
- Prodigi product identified by the user: `GLOBAL-CFP-11X14`.
- Observed working fulfillment assumption ≈ $62 delivered — used only for
  economics/admin display, **never hardcoded as a guaranteed provider cost**. The
  real cost must come from a live provider quote before submission.

Only an **actually earned digital certificate** can be ordered physically. No
arbitrary image uploads, no editing the certificate before manufacturing: Prodigi
receives the exact immutable print artifact generated for that certificate.

## Domain

`physical_certificate_orders` (migration 0026, additive):
`id, customerIdentityId, certificateId, commercialOrderId, sku, quantity,
retailAmountMicros, currency, paymentStatus, fulfillmentStatus, fulfillmentProvider,
providerOrderId, providerQuoteAmountMicros, shippingAmountMicros,
estimatedContributionMicros, shippingAddressSnapshot (jsonb, minimal), trackingCarrier,
trackingNumber, trackingUrl, failureCode, failureDetailSafe, createdAt, paidAt,
submittedAt, shippedAt, deliveredAt, updatedAt`.

Statuses: `PENDING_PAYMENT → PAID → PREFLIGHT → SUBMITTED → IN_PRODUCTION → SHIPPED
→ DELIVERED`, plus `CANCELLED`, `FULFILLMENT_FAILED`, `REFUND_PENDING`, `REFUNDED`,
`REPLACEMENT_PENDING`, `REPLACED`.

## Payment / commerce boundary

Reuses the existing `CommerceProvider` (Whop / Mock) and Standard Webhooks. A merch
order creates a `commercial_orders` row with a new `source = 'MERCH'` so the
completed-order path **skips account provisioning entirely** — a certificate
purchase never creates a trading account. A server-authenticated payment event is
authoritative; a browser success screen never provisions or submits fulfillment.
SKU/product mapping is immutable.

## Preflight (payment confirmed → NOT blindly submitted)

```
payment confirmed (webhook PAYMENT_SUCCEEDED for a MERCH order)
  → mark physical order PAID
  → verify certificate exists
  → verify certificate belongs to the buyer
  → verify certificate eligible for physical ordering
  → verify the print artifact exists and its hash matches
  → verify the SKU is configured
  → validate the shipping address
  → obtain a provider quote
  → apply fulfillment-cost safety rules
  → create an idempotent provider order
  → persist provider order id
  → track fulfillment
```

Any preflight failure moves the order to a safe exception state
(`FULFILLMENT_FAILED` with a safe reason); a manufacturing order is never submitted.

## `FulfillmentProvider` abstraction

`apps/server/src/platform/fulfillment-provider.ts` — the domain never couples to
Prodigi directly:

```
interface FulfillmentProvider {
  readonly name: 'MOCK' | 'PRODIGI';
  isConfigured(): boolean;
  quote(input): Promise<Quote>;
  validateProduct(sku): Promise<boolean>;
  createOrder(input): Promise<ProviderOrder>;   // idempotent on our order id
  getOrder(providerOrderId): Promise<ProviderOrder>;
  cancelOrder(providerOrderId): Promise<void>;  // where supported
  normalizeWebhook(raw): NormalizedFulfillmentEvent;
  getTracking(providerOrderId): Promise<Tracking | null>;
}
```

- `MockFulfillmentProvider` — deterministic dev/test default (quotes ≈ $62, creates
  a mock provider order, emits tracking).
- `ProdigiFulfillmentProvider` — provider-ready seam. **Requires** `PRODIGI_API_KEY`,
  `PRODIGI_ENV=sandbox|production`, `PRODIGI_ENABLED=true`. Never enabled by default;
  never commits secrets; never fabricates a successful production order. Selected by
  env only when explicitly enabled, else the mock is used.

Production activation is a later controlled step (credentials, sample order, print +
shipping quality approval, webhook verification, pricing confirmation, replacement
process) — see the M6 report.

## Customer UX

On an eligible certificate: *Digital Certificate — Included* and *Premium Framed
Certificate — 11×14 — $99.99* with **Order Framed Copy**. Flow: preview the exact
certificate → confirm shipping address → review product/size/price/shipping/total →
checkout → server verifies payment → preflight → auto-submit → dashboard order
tracking (`ORDER CONFIRMED → IN PRODUCTION → SHIPPED → DELIVERED`, with tracking when
available). Provider internals are not exposed to the customer.

## 100K plaque (special, manual)

The 100K Club is **never** routed to a provider. Crossing ≥ $100k lifetime
trader-share PAID issues the `HUNDREDK_CLUB` reward and creates a
`physical_reward_fulfillment` row (`type = 'PLAQUE_100K'`, status `PENDING_REVIEW`).
The customer can confirm a shipping address; the owner marks `VERIFIED → ORDERED →
SHIPPED → DELIVERED` (or `CANCELLED`/`HOLD`) and can enter tracking. No automatic
manufacturing, no provider API, no automatic spending.

## Owner operations

A read-only/operational Certificate Store view: total physical orders, revenue,
fulfillment cost, estimated contribution, AOV, orders needing attention, and
per-order detail (certificate, customer, amounts, provider + provider order id,
status, tracking, timestamps, safe failure reason). Retry / replacement / refund
controls only where the operational architecture supports them safely. No owner
backdoor issues fake *earned* certificates.

## Security

Customer cannot order another customer's certificate, forge a certificate id, change
the amount/name/date, supply an arbitrary print URL or SKU, mark an order paid, or
mark it shipped. Provider webhooks are signature-verified and replay-idempotent. No
secrets reach the browser. Path traversal is impossible in the local artifact
adapter.

---

## M6.1 update — print artifact & resolution

Framed orders use the certificate's **immutable full-resolution PNG** print
artifact (frozen with its renderHash), never an upscaled thumbnail. The approved
V1 masters are 1536×1024 (~110 DPI at 11×14), which is **below print quality** —
physical framed printing is gated on higher-resolution masters (~4200×3300 for
300 DPI); see `docs/production-certificate-assets-v1.md`. Digital issuance is
unaffected. The 100K plaque remains manual and is never routed through this
automated framed-certificate commerce or Prodigi.
