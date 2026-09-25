# 07 — Refunds, chargebacks, and reversals

Commissions are earned on real revenue. When that revenue is refunded or charged
back, the commission is reversed — correctly, and without ever rewriting history.

## Where it hooks in

`commerce-refund.ts` calls `reverseCommissionForOrder(db, orderId, reason)` after:

- `handleRefund` completes, and
- `handleDispute(opened)` (a chargeback opens).

Both calls are idempotent and wrapped so a missing commission is a no-op (an order
with no affiliate conversion simply has nothing to reverse).

## The two cases

`reverseCommissionForOrder` looks at the commission's current status:

1. **Before maturity** (`TRACKED`/`PENDING`/`HELD`): the commission is set to
   `CANCELED`. It never became available, so the balance is untouched (the
   reversal ledger entry carries amount 0). The money simply never lands.
2. **After maturity** (`PAYABLE`/`PAID`): the commission is set to `REVERSED` and
   a `COMMISSION_REVERSED` entry of `−commissionMicros` is posted. If the money had
   already been paid out, the available balance goes **negative** — an honest debt.

An already-reversed/canceled commission returns `{ reversed: false }` — it is
idempotent under duplicate refund/chargeback webhooks.

## Qualification impact

A reversed or canceled commission's revenue is excluded from monthly tier
qualification (doc 05), so a refunded sale cannot inflate a tier.

## Where it is verified

`affiliate-commission.test.ts`:

- refund **before** maturity → `CANCELED`, balance stays 0;
- refund **after** maturity → `REVERSED`, available returns to 0;
- chargeback **after** payout → available goes to `−commission`, `lifetimePaid`
  preserved.

`affiliate-tiers.test.ts` proves a reversed conversion drops out of qualified
revenue.

## Manual adjustments

`manualAdjustment` posts a signed `MANUAL_ADJUSTMENT` entry with a required
reason code and explanation (audited). It is the only owner path to correct a
balance, and it too can drive the balance negative — there is no destructive edit.
