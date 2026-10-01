# Portal V2 — Billing Architecture

Billing presents the customer's purchases, entitlements, payment method and order→account
provenance. It is provider-safe: **no raw card data ever touches our origin or our storage.**

## View model
`BillingView`: `totalSpentMicros`, `orderCount`, `activeEntitlements`, `orders[]`,
`paymentMethod?`.
- `OrderRow`: `id`, `dateMs`, `item`, `amountMicros`, `state` (`PAID`/`REFUNDED`/`PENDING`),
  `accountId?` — the **provenance** link from a purchase to the account it provisioned.
- `PaymentMethodView`: `brand`, `last4`, `expMonth`, `expYear` — **only** the provider's
  safe projection. There is no card-number field anywhere in the model.

## Actions (seams)
`BillingActions`:
- `onAddAccount` → the legitimate purchase flow (app root). Present in the header and the
  empty-state.
- `onManagePaymentMethod` → a **provider-hosted** add/update flow. Card entry happens on the
  provider's surface; we never render a card form. Dev review routes to `/onboarding`.
- `onViewReceipt(orderId)` → opens/downloads a server- or provider-rendered receipt. Not
  wired in the dev review (no real receipt artifact) → the Receipt link simply doesn't render,
  rather than faking a document.

## Provenance (purchase → account)
Each settled order that provisioned an account carries `accountId`; the orders table links to
the owning account's detail ("View account →"). This is the money-trace the customer sees:
which purchase created which account. Backed by the commerce read model
(`commercial_orders` → `entitlements` → provisioned evaluation/account), established in the
commerce milestone.

## Refunds
`REFUNDED` orders render with a neutral status. Refund/chargeback reversal logic is
server-authoritative (commerce engine); the portal only reflects the resulting order state.

## Safety invariants
1. No raw PAN/CVV/expiry entry in-portal; management is provider-hosted.
2. Only provider-returned brand/last-4/expiry are displayed.
3. Order amounts are authoritative micro-dollar integers from the commerce read model —
   never computed client-side.
4. Zero-customer: `FIXTURE_BILLING_EMPTY` — $0 spent, no orders, no payment method, with an
   Add-account path.

## Seams / debt
- Real receipt artifact endpoint is not yet surfaced in V2 (`onViewReceipt` seam).
- Invoices (as distinct documents from receipts) are not yet modelled in V2.

---
## Review #3 — deeper payment management (provider-safe)
Payment method now renders a real card face + provider-safe billing contact (status/default,
billing name/email/country — only what the provider returns). "Manage" opens a modal showing the
card, a clear explanation that card data lives with the provider (never our servers/app), and
"Continue to secure provider ↗" (the real provider-hosted seam). No card form, no fake "card
updated". Purchase→account provenance and receipts seam unchanged from R2.
