# PAYOUT_MODEL

The payout maths reuse the **real** payout engine so a simulated payout and a real one
can never diverge.

## 90/10 split

`splitAccounting(grossMicros, 0.90)` from `apps/server/src/platform/payout-core.ts`:

- `traderShareMicros = roundHalfEven(gross × 0.90)` — the firm's **payout expense**
- `firmShareMicros = gross − traderShare` — retained (rounding remainder absorbed here)
- Invariant: `traderShare + firmShare = gross` exactly.

## Caps, minimum, cycles (authoritative)

- Request cap per size: 25K $1,000 · 50K $2,000 · 100K $3,500 · 300K $5,000 (flat).
- Minimum request: $250.
- Each modelled payout draws a gross in `[min, cap]`, skewed toward
  `avgPayoutFractionOfCap`.
- `MAX_PAYOUT_CYCLES = 5` — after five payouts an account completes; the payout loop is
  bounded by it. (Constant now lives in `payout-core.ts`, re-exported by `payouts.ts`.)

## Modelled lifecycle states

The real system has an economic state machine (REQUESTED → UNDER_REVIEW → APPROVED →
PROCESSING → PAID, plus REJECTED/CANCELLED/FAILED) and an operational one. The engine
models the cash-relevant distinction:

| Modelled state | Meaning in the engine |
|----------------|-----------------------|
| eligible | account survived to payout eligibility |
| requested / approved | payout drawn; balance debited (liability incurred) |
| paid | cash left the firm (`approval + PAYOUT_SETTLE_DAYS ≤ horizon`) |
| approved-unpaid | approved within horizon, settles after it → **liability** |

`paidTraderShare + approvedUnpaidTraderShare ≤ traderShare` (invariant).

## Family specifics

- **SELECT** — the 40% payout consistency rule is modelled as a per-attempt delay
  (`selectConsistencyBlockRate`): it skips a payout without ending the account.
- **DAILY** — the progressive-balance rule and buffer are authoritative payout gates;
  in the economics model they manifest as the assumption inputs
  (`firstPayoutProb` / `repeatPayoutProb` / buffer in the catalog). The detailed
  balance-progression gating lives in `payout-core.ts` and is not re-implemented here.
