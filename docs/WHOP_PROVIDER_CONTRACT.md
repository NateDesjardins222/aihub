# Whop Provider Contract (verified)

**Phase:** Whop Commerce Integration — Phase 1 (CORE 50K canary). **Baseline:** `9ee0e51`.
**Method:** read from CURRENT official Whop developer documentation (not memory, not tutorials, not blogs),
October 2026. Every field below was confirmed against a `docs.whop.com` page; source links are inline. Where a
page was a schema stub, the fact is marked and carried as a canary-time verification item rather than guessed
(per §36 "DO NOT GUESS WHOP").

This document is the authoritative reference for how Happy Trader reads Whop. The adapter (`whop.ts`,
`whop-client.ts`, `commerce-provider.ts`) implements exactly this; nothing downstream depends on Whop shapes.

## Sources
- Webhooks guide — https://docs.whop.com/developer/guides/webhooks
- Payment object — https://docs.whop.com/api-reference/payments/payment
- Payment succeeded (event) — https://docs.whop.com/api-reference/payments/payment-succeeded
- Create checkout configuration — https://docs.whop.com/api-reference/checkout-configurations/create-checkout-configuration
- Refund payment — https://docs.whop.com/api-reference/payments/refund-payment
- API getting started / auth — https://docs.whop.com/developer/api/getting-started
- Sandbox — https://docs.whop.com/developer/guides/sandbox

## 1. Webhook authenticity — Standard Webhooks

| Concept | Verified value | HT destination | Security significance |
|---|---|---|---|
| Spec | Standard Webhooks (standardwebhooks.com) | `verifyStandardWebhook` (`whop.ts`) | The ONLY thing that authorises provisioning. |
| Headers (frozen, every version) | `webhook-id`, `webhook-signature`, `webhook-timestamp`, `content-type` | read in `whop.ts` | Missing any → reject. |
| Signed content | `{webhook-id}.{webhook-timestamp}.{raw body}` | exact string HMAC'd | Must use the RAW body — parsing first changes bytes and fails. |
| Algorithm | HMAC-SHA256, header value `v1,<base64>` (space-separated list ⇒ rotation) | constant-time compare, any listed `v1` may match | Timing-safe; a bad signature is a 401, never a 500. |
| Secret format | `ws_...`, used as given (do not strip prefix, do not re-encode) | `WHOP_WEBHOOK_SECRET`; `deriveKey` strips the `ws_`/`whsec_` prefix and base64-decodes the remainder (the Standard Webhooks reference key derivation, which `@whop/sdk`'s `unwrapWebhook` performs internally) | Never logged, never returned to the browser. |
| Timestamp tolerance | reject if `webhook-timestamp` is more than 5 minutes from now | `DEFAULT_TOLERANCE_SECONDS = 300` | Replay window bounded. |
| Delivery | at-least-once; retries 30s, 2m, 8m, 30m, 1h, 3h, 6h, then 12h (~71h) | — | HT is idempotent regardless (see §13 below). |
| Response | 2xx within 5s; everything else = failed delivery | route returns fast after fulfil | Long work must not block the 2xx. |

> Canary-time verification: confirm the live sandbox secret verifies against this exact derivation on the
> first real webhook. If it does not, the documented fallback is the official `@whop/sdk/helpers`
> `unwrapWebhook(payload, { headers, key })` — same algorithm, same inputs.

## 2. Webhook event types (verified list)

`payment.succeeded` (the one HT fulfils), plus `payment.authorized|canceled|created|failed|pending|requires_action`;
`membership.activated|deactivated|cancel_at_period_end_changed|trial_ending_soon`;
`dispute.created|dispute.updated`; `refund.created|refund.updated`; `invoice.*`.

HT's `kindFromType` (`commerce-provider.ts`) maps `payment.succeeded → PAYMENT_SUCCEEDED`,
`payment.failed → PAYMENT_FAILED`, `refund.created → REFUND`, `dispute.created → DISPUTE_OPENED`,
`dispute.updated/closed → DISPUTE_CLOSED`; everything else → `UNKNOWN` (acknowledged 200, no action).

## 3. Event envelope + payment object (verified fields)

Envelope: `{ id: "msg_…", type, api_version, api_version_date, timestamp (ISO), account_id: "biz_…", data: {…} }`.

Payment object (`data` on `payment.succeeded`) — exact field names:

| Whop field | Type / example | HT destination | Notes |
|---|---|---|---|
| `id` | `pay_…` | order `externalReference` (receipt) | the receipt id |
| `subtotal` | number \| null, `6.9` = $6.90 | amount validation (preferred) | **DECIMAL dollars**, not cents/micros |
| `total` | number \| null | amount validation (fallback) | may include tax |
| `amount_after_fees`, `settlement_amount`, `usd_total` | number | — (not used for price match) | merchant-net / settlement figures |
| `currency` | `Currencies`, e.g. `"usd"` | currency validation | compared case-insensitively |
| `user.id` | `user_…` | `providerCustomerId` (provenance) | preferred customer id |
| `member.id` | string | `providerCustomerId` (fallback) | |
| `membership.id` | `mem_…` | — (not needed in canary) | |
| `plan.id` | `plan_…` | **product-mapping key** | the stable id the mapping uses |
| `product.id` | `prod_…` | product-mapping fallback | coarser than plan |
| `metadata` | object \| null | carries `atlasOrderId` | inherited from the checkout config |
| `status` | `draft\|open\|paid\|void` | — | |
| `paid_at`, `created_at`, `updated_at` | ISO date-time | — | |
| `refundable`, `refunded_amount`, `refunded_at`, `refunds[]` | refund state | refund correlation (future) | |

**Money rule:** Whop expresses money as a decimal number of dollars. HT converts to integer micro-dollars with
`dollarsToMicros(x) = Math.round(x * 1_000_000)` and validates against the order's pinned price. The CORE 50K
plan must be priced tax-inclusive/no-tax so `subtotal == total == $95`; HT validates `subtotal` first for that
reason. A present contradiction → `PRICE_MISMATCH`, never provision.

## 4. Metadata correlation (the identity + order spine)

Verified: "Payments and memberships created from a checkout session inherit its metadata." HT creates the
checkout carrying `metadata: { atlasOrderId }`; the `payment.succeeded` payload echoes it at
`data.metadata.atlasOrderId`. That order already names the authenticated Happy Trader `users.id` and the pinned
product version — so identity and product are bound by the order, not inferred from Whop's customer or email. No
duplicate identity is ever minted from a Whop payload.

## 5. Checkout (verified)

Current method: `POST /api/v1/checkout_configurations` (base `https://api.whop.com/api/v1`, sandbox
`https://sandbox-api.whop.com/api/v1`), Bearer API key. Body `{ plan_id, metadata, redirect_url }`. Response
`{ id: "ch_…", plan: { id }, purchase_url: "/checkout/ch_…/" }`. HT absolutizes the relative `purchase_url`
against `https://whop.com`. `whop-client.ts` implements this, SANDBOX-only, behind `WHOP_SANDBOX=true` + an API
key.

> Canary-time verification: the checkout-creation endpoint/response is credential-gated and can only be
> confirmed against the live sandbox. It is NOT on the money-truth path (the webhook is), so a checkout-shape
> surprise cannot mis-provision — it only affects starting a checkout. The legacy v2 `/checkout_sessions`
> endpoint is the documented fallback if the sandbox rejects v1.

## 6. API authentication (verified)

Base `https://api.whop.com/api/v1`; every request `Authorization: Bearer <API key>`. App API keys (for data on
accounts that installed the app) vs OAuth (act on a user's behalf). HT uses only a server-side company/app API
key to create a checkout; it performs no charge and never sees a card.

## 7. Refunds / disputes / cancellations (verified, NOT auto-acted this phase)

- Refund API: `POST /api/v1/payments/{id}/refund`, optional `partial_amount` (decimal, in the charge currency).
  Events `refund.created` / `refund.updated`.
- Disputes: `dispute.created` / `dispute.updated`; the payment object carries `disputes[]` and `resolutions`.
- HT maps these event kinds to `REFUND` / `DISPUTE_OPENED` / `DISPUTE_CLOSED` and routes them to the existing
  `handleRefund` / `handleDispute` handlers, which record provider truth and surface operator attention. Happy
  Trader's business rule (refund only if no trade) is unchanged, and NO account is destroyed automatically on a
  guessed refund/dispute event — see `WHOP_COMMERCE_ARCHITECTURE.md`.

## 8. Test / development (verified)

Sandbox: separate dashboard `sandbox.whop.com`, separate keys, base `https://sandbox-api.whop.com/api/v1`,
test cards, money never moves. Local webhooks: `whop apps dev` + a tunnel (e.g. Pinggy) pointed at the webhook,
with the dashboard webhook's signing secret stored as `WHOP_WEBHOOK_SECRET`. HT's non-prod `/webhooks/mock`
endpoint also lets the offline test suite post a genuinely-signed event without any Whop account.

## 9. What HT deliberately does NOT read

The membership lifecycle, invoices, payment instrument details, settlement/fee figures, and the full Whop
customer object. HT needs only: which order was paid (`metadata.atlasOrderId`), the receipt (`data.id`), the
plan (`data.plan.id`), the confirmed amount/currency, and the customer id for provenance. Keeping the surface
this small IS the anti-corruption boundary.
