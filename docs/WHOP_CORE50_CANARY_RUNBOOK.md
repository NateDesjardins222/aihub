# CORE 50K Canary Runbook (Whop Commerce Phase 1)

How to configure, run, verify, recover and disable the first real Whop purchase of a Happy Trader CORE 50K
evaluation ($95). No secrets appear in this document. Companion: `WHOP_PROVIDER_CONTRACT.md`,
`WHOP_COMMERCE_ARCHITECTURE.md`.

CORE 50K reference (business rules frozen): price **$95**, profit target **$3,000**, EOD trailing drawdown
**$2,000** (floor $48,000 → lock at $50,000), max **5 minis / 50 micros**, evaluation consistency **50%**,
funded consistency none, payout cap **$2,000**.

## 0. What is credential-gated (needs Nathan)

Claude built and tested everything that does not require a Whop account. The live canary needs Nathan to create
the Whop app, keys, webhook and a CORE 50K plan, and to perform a controlled sandbox purchase. Those exact steps
are in §2 and in the final report's "NATHAN ACTIONS STILL REQUIRED". The signature-verified webhook path (the
money truth) is already implemented and tested offline with a mock-signed event.

## 1. How product mapping works

`WHOP_PLAN_MAP` is a JSON object `{ "<internal product key>": "<Whop plan id>" }`. For the canary, one entry:
`{"htf-core-50k":"plan_XXXXXXXX"}` (the real plan id from Whop). The checkout uses it to pick the plan for CORE
50K; the webhook cross-checks the paid `plan.id` against it (mismatch → `UNKNOWN_PRODUCT`, no provisioning). The
product's own `config.whopPlanId` is only a fallback placeholder — the env map carries the REAL id. Adding the
other nine products later = add nine more entries here (no code change).

## 2. Nathan — Whop dashboard setup (sandbox)

```
NATHAN ACTION REQUIRED — Whop sandbox setup

WHY: creating a Whop app, API key, webhook and a CORE 50K plan requires the human
     account owner; Claude cannot create Whop credentials or offerings.

OPEN: sandbox.whop.com  (the SANDBOX dashboard — money never moves here)

DO:
  1. Create (or open) a business, then Developer → Apps → Create app.
  2. Create a sandbox API key (App/Company API key).  [SECRET]
  3. Developer → Webhooks → Create webhook. Endpoint URL = your running server's
     https://<host>/api/v1/webhooks/whop  (for local, expose it with a tunnel — see §4).
     Select at least the "payment.succeeded" event.
  4. Copy the webhook Signing secret (a "ws_..." string).  [SECRET]
  5. Create a CORE 50K plan priced $95, configured tax-inclusive / no separate tax
     line so the payment's subtotal and total both equal 95.00.
  6. Copy the plan id ("plan_...").  [NON-SECRET]
  7. Copy the company id ("biz_...").  [NON-SECRET]

COPY (non-secret, paste back to Claude or into .env): the plan id, the company id.

SECRET (never paste into chat — put in apps/server/.env locally):
  WHOP_WEBHOOK_SECRET=ws_...         (from step 4)
  WHOP_COMPANY_API_KEY=apik_...      (from step 2)

AFTER: set the non-secret env below and start the server (§3), then run §5.
```

## 3. Happy Trader environment

In `apps/server/.env` (local only; never commit — see `apps/server/.env.example`):

```
WHOP_SANDBOX=true
WHOP_WEBHOOK_SECRET=ws_...            # SECRET, from the dashboard
WHOP_COMPANY_API_KEY=apik_...         # SECRET, from the dashboard
WHOP_COMPANY_ID=biz_...               # non-secret
WHOP_CHECKOUT_RETURN_URL=https://<host>/portal/billing
WHOP_PLAN_MAP={"htf-core-50k":"plan_XXXXXXXX"}
```

Behaviour: with `WHOP_WEBHOOK_SECRET` set, the active commerce provider is Whop (`commerceProviderFromEnv`), the
webhook verifies real signatures, and checkout can create a sandbox session. With it unset, the webhook refuses
every request and no money path exists. The mock `/webhooks/mock` endpoint is non-production only.

## 4. Start locally + expose the webhook

```
# DB up, migrated, seeded (the 10 products incl. htf-core-50k):
bash scripts/prepare-test-db.sh        # or the normal dev DB + pnpm --filter @atlas/server db:migrate && db:seed
pnpm --filter @atlas/server dev        # starts the server
```
Expose `…/api/v1/webhooks/whop` publicly for Whop to reach it: use the Whop CLI dev proxy + a tunnel
(`whop apps dev`, then a Pinggy/ngrok HTTPS tunnel), or deploy to a reachable host. Point the dashboard webhook
(step 3.3) at the tunnel URL. This is the documented official local-webhook path.

## 5. Perform the canary purchase (L5 human acceptance)

1. Sign into Happy Trader as a test customer who has cleared the provisioning gate (verified contacts + verified
   identity + accepted agreements).
2. Select CORE 50K, click Buy → `POST /api/v1/checkout` creates a PENDING order ($95 pinned) and a Whop checkout;
   you are taken to Whop's checkout.
3. Complete the purchase with a Whop sandbox test card.
4. Return to Happy Trader (`WHOP_CHECKOUT_RETURN_URL`). If the webhook has not landed yet, the page shows
   "purchase processing" — it polls `GET /commerce/orders/:id/status` and NEVER provisions itself.
5. When `payment.succeeded` arrives and verifies, the order flips PENDING → COMPLETED → PROVISIONED and a CORE
   50K evaluation account appears.

## 6. Verify (each check, no SQL)

- **Event received + authentic:** Owner OS → Customer 360 → "Commerce — provider events": the row shows
  provider WHOP, the event id, `✓ verified`, state PROCESSED, the receipt and customer id.
- **Order:** "Commerce — orders": one PURCHASE order, provider `whop`, amount `$95.00`, status PROVISIONED.
- **Entitlement:** "Entitlements": one EVALUATION entitlement, consumed into the account.
- **Account:** "Accounts": one EVALUATION account, starting balance $50,000.
- **Portal (customer):** Portal → Billing shows CORE 50K, $95, purchase date, state, and a link to the account.
- **Atlas:** the account is tradable through the normal account system (no Whop-specific source).
- **Account status API:** `GET /commerce/orders/:id/status` returns `PROVISIONED` + the `accountId`.

## 7. Inspect a failure

If provisioning cannot complete (gate not cleared, cap reached, transient error), the order parks
`PROVISION_BLOCKED` / `PROVISION_FAILED` — money kept. Find it in Owner OS → provisioning exception queue, with
the `provisionNote`. The customer sees a truthful "needs attention" state, not a fake completion.

Deliberate rejections (nothing provisions, event recorded REJECTED with a precise reason, order stays PENDING):
- wrong plan → `UNKNOWN_PRODUCT`; wrong amount or currency → `PRICE_MISMATCH`; missing/unknown order →
  `UNKNOWN_ORDER`; bad/absent signature or stale timestamp → 401 `BAD_SIGNATURE` / `STALE`.

## 8. Retry safely

Owner OS → provisioning exception → "Retry provisioning" (`POST /customers/orders/:id/retry-provisioning`, ADMIN,
audited). It re-reads persisted state and completes the SAME order/entitlement/account — it does not fake another
Whop event or create duplicates. Re-run as needed for a transient failure.

## 9. Confirm no duplicate account

Whop retries `payment.succeeded` (at-least-once). Each retry is deduped on `(provider, providerEventId)` and the
layered idempotency keys, so the business effect is exactly one order, one entitlement, one account. Verify in
Customer 360: exactly one EVALUATION account for the order, and repeated provider-event rows (if any) all resolve
to the same account. The cap guard means a customer already at 5 active accounts never gets a sixth — the payment
parks recoverably instead.

## 10. Disable the integration safely

Unset `WHOP_WEBHOOK_SECRET` (and/or set `WHOP_SANDBOX=false`) and restart. The webhook then refuses every request
(503/401), checkout reports not-configured, and no money path exists. Existing accounts/orders are untouched.
Deleting the dashboard webhook at Whop stops deliveries at the source.
