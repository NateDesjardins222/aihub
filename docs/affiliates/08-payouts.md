# 08 — Affiliate payouts

Payouts are **provider-neutral** and **truthful**. Until a real payout rail is
configured and verified, the system says so plainly and never fakes a transfer.

## Provider status

`affiliatePayoutProviderStatus()` returns `{ provider, configured, verified,
status, note }`. With nothing configured it reports `configured: false,
verified: false` and an honest note. System Doctor surfaces this as
`affiliate_payouts: NOT_CONFIGURED` at **INFO** severity — informational, not a
critical fault (doc 10). It never claims a payout was sent from config alone.

## Requesting a payout

`requestPayout(db, { affiliateId, amountMicros, actor })`:

- takes a per-affiliate advisory lock inside a transaction,
- enforces the configurable **minimum payout** (`minPayoutMicros`, default $50),
- enforces `amount <= withdrawableMicros` (available minus already in-flight),
- creates the payout in `REQUESTED`.

Two concurrent full-balance requests → exactly one succeeds (double-withdraw
prevented; proven in `affiliate-payouts.test.ts` and `affiliate-commission.test.ts`).

## Lifecycle

```
REQUESTED → APPROVED → PAID
         ↘ CANCELED / FAILED
```

- `approvePayout` moves it toward payment.
- `cancelPayout` / `failPayout` take it out of flight; the withdrawable balance is
  restored (nothing left the ledger).
- `markPayoutPaid(db, id, { externalReference, method, evidenceRef?, actor })` is
  the **only** path that moves money out: it posts `PAYOUT_PAID −amount`. It
  **requires** an external reference and a method (evidence) — a call without them
  is refused. This is where a real transfer's proof is recorded.

## Balances

While requested/processing, the amount is `inFlightPayoutMicros` and
`withdrawableMicros` drops accordingly, but `availableMicros` is unchanged until
`PAID`. On `PAID`, `available` drops and `lifetimePaidMicros` rises. (doc 06)

## Config

`minPayoutMicros` is versioned config; raising it blocks a previously-valid
request (proven in `affiliate-integrity.test.ts`).

## Owner operations

The console exposes approve / cancel / fail, and an evidence-gated **Mark paid**
that requires a `FINANCIAL` step-up (doc 10). No external transfer is performed by
the console — marking paid records that a transfer happened out-of-band.
