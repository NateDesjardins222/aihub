# Owner OS — Financial Operations & Money Trace

Module: `financial-ops.ts`
Routes: `/api/v1/admin/ops/finance/summary`, `/finance/money-trace/payout/:id`,
`/agreements`

## Financial summary (aggregated from source objects, no fabrication)

`financialSummary(db, org)` derives, from authoritative records:

- `purchaseRevenueMicros` — from commercial orders,
- `outstandingPayoutLiabilityMicros` — owed but not yet paid,
- `paidTraderPayoutMicros` — paid to traders,

and related counts. Nothing here is a stored total that can drift; every figure is
computed from source rows. Requires `finance.read`.

## Money trace for a payout

`payoutMoneyTrace(db, payoutId)` follows one payout end to end:

- **eligibility** — the server's eligibility evaluation (state + reason codes),
- **ledger** — the authoritative `payout_ledger` entries,
- **state** — the current payout state and whether it is settled (PAID).

This is how an operator answers "why is this payout in this state and where is the
money?" without guessing — every element comes from the payout engine and ledger.

## Agreement center

`agreementCenter(db, org)` lists agreement versions with acceptance counts, so the
owner can see which legal versions are live and how many customers accepted each.

## Product economics are LOCKED

The Owner OS does not let anyone casually edit the locked product rules (CORE /
SELECT / DAILY economics, payout caps/minimums, the 90/10 split and 50% rule, the
DAILY progressive qualifying-balance rule, ≤5 active accounts per identity, ≤5
payout cycles, EOD trailing drawdown, winning-day ≥ $150). Product configuration is
versioned and audited elsewhere; the Owner OS surfaces and enforces these rules, it
does not re-implement or quietly change them.
