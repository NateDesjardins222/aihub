# ASSUMPTIONS — Category A vs Category B

## Category A — AUTHORITATIVE (loaded, never re-typed)

Loaded by `config.ts` from the shared catalog (`@atlas/contracts/product-catalog.ts`)
and the pure payout engine (`payout-core.ts`), plus firm limits from `payouts.ts` /
`account-limit.ts`:

- 10 products (CORE 25/50/100/300K Gold, SELECT 25/50/100K, DAILY 25/50/100K)
- Evaluation price per product ($65 … $599)
- Payout request cap per size (25K $1,000, 50K $2,000, 100K $3,500, 300K $5,000)
- Minimum payout request $250
- Trader profit split **90%**; activation fee **$0**
- Winning days required **5**, winning-day threshold **$150**
- Daily loss buffers (25K $1,000, 50K $2,000, 100K $4,000)
- Max payout cycles **5**; max active accounts **5**

These are **not** duplicated in the engine — they are read from the one source.

## Category B — ASSUMPTIONS (explicit, editable, versioned; NOT facts)

Defined in `config.ts` `defaultAssumptions()` (the BASE set). Every field is a planning
input, never presented as measured Happy Trader data.

| Field | BASE | Meaning |
|-------|------|---------|
| passRate | 0.10 | P(evaluation passes) |
| resetRateOnFail | 0.25 | P(buy a reset after a fail) |
| repurchaseRateOnFail | 0.15 | P(buy a fresh eval after a fail) |
| maxResetsPerAccount / maxRepurchases | 2 / 2 | caps on repeat purchases |
| fundedSurvivalToPayout | 0.40 | P(funded account reaches eligibility) |
| firstPayoutProb | 0.50 | P(eligible account takes a first payout) |
| repeatPayoutProb | 0.40 | P(each subsequent payout) |
| avgPayoutFractionOfCap | 0.50 | mean payout as fraction of the cap |
| selectConsistencyBlockRate | 0.25 | SELECT payout-delay rate |
| refundRate / chargebackRate | 0.03 / 0.01 | per purchase |
| chargebackFeeMicros | $15 | flat fee per chargeback |
| processingPct / processingFixedMicros | 4.5% / $0.30 | **not in production config** |
| operatingCosts[] | see below | fixed monthly + per-customer + per-payout lines |
| acquisitionModel / cacPerCustomerMicros | MIXED / $12 | acquisition |
| affiliatePenetration | 0.35 | fraction of customers referred |
| affiliateCommissionRate | 0.15 | authoritative default rate, editable here |
| affiliateMaturityDays | 14 | authoritative default |
| affiliateCommissionOnResets | false | authoritative default |
| payout/affiliateLiabilityCoverage | 1.0 / 1.0 | reserve coverage multiples |
| refundReservePct | 0.04 | reserve vs gross sales |
| operatingReserveMonths | 3 | reserve months of opex |
| taxPlaceholderPct | 0.21 | reserve vs positive contribution |
| safetyReserveMultiplier | 1.0 | × Monte-Carlo payout tail |
| arrivalPattern | LINEAR | growth timing |
| firstPayoutLagDays / payoutIntervalDays | 45 / 21 | payout timing |
| affiliatePayoutLagDays | 30 | affiliate cash timing |
| refundLagDays / chargebackLagDays | 10 / 40 | dispute timing |

Operating cost lines (BASE): market data & execution, hosting/db/storage, email & SMS,
identity/KYC, support, payout-provider processing, software/services, legal/compliance
placeholder. Each has a fixed monthly and/or per-customer and/or per-payout component.

**None of these vendor prices are represented as factual** — they are configurable
placeholders. Processing fees are explicitly modelled as assumptions because there is
**no payment-processing fee anywhere in production config** (Whop holds card data; the
app moves no money and stores no fee schedule).
