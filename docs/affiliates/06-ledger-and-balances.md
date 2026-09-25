# 06 — The ledger and balances

The `affiliate_ledger` is the single source of truth for affiliate money. It is
append-only and every balance is derived from it.

## Append-only

A database trigger (`affiliate_block_mutation`, `BEFORE UPDATE OR DELETE`) raises
`<table> is append-only`. There is no code path — and no SQL — that can rewrite or
delete a ledger row. Reversals are new, signed entries, never edits. Verified in
`affiliate-payouts.test.ts` (UPDATE and DELETE both rejected; the row survives).

## Entry types

| Entry type | Amount | Meaning |
| --- | --- | --- |
| `COMMISSION_CREATED` | 0 | lifecycle marker (commission tracked) |
| `COMMISSION_MATURED` | +commission | money becomes available |
| `COMMISSION_REVERSED` | −commission (if it had matured/paid) | refund/chargeback |
| `PAYOUT_PAID` | −amount | money leaves on a settled payout |
| `PAYOUT_RETURNED` | +amount | a returned payout comes back |
| `MANUAL_ADJUSTMENT` | ± | owner correction (audited, reason required) |

Balance-moving entries carry a signed amount; lifecycle-only entries carry 0 so
the running sum stays exact.

## Derived balances

`affiliateBalance(db, affiliateId)` returns:

- `availableMicros` = **Σ all ledger amounts** (the core invariant),
- `pendingMicros` = commissions still in `TRACKED`/`PENDING`/`HELD` (in the
  maturity holdback, not yet available),
- `inFlightPayoutMicros` = requested/processing payouts,
- `withdrawableMicros` = `available − inFlight`,
- `lifetimePaidMicros` = Σ of `PAYOUT_PAID` (as a positive total),
- `reversalMicros` = Σ of reversals.

## The invariant, tested directly

`affiliate-economics.test.ts` asserts `availableMicros === Σ(ledger.amountMicros)`
after create → mature → adjust → refund, at every step. A lifecycle-only entry is
asserted to carry amount 0.

## Negative balances are allowed

If a paid commission is later charged back, the reversal posts a negative entry
and the available balance can go **negative** while `lifetimePaidMicros` preserves
the paid history. This is deliberate: it records a genuine debt rather than hiding
it. Proven in `affiliate-commission.test.ts`.
