# 13 — Runbooks

Operational procedures for the affiliate program. All money actions require a
`FINANCIAL` step-up; all are audited.

## Review an application
1. Owner console → **Affiliates → Applications**.
2. **Approve** (moves to `APPROVED_PENDING_AGREEMENT` — does **not** activate),
   **Request info**, or **Decline** (reason required).
3. The applicant accepts the agreement in their portal to activate.

## Grant a strategic (custom) rate
1. Affiliate 360 → **Actions → Change commission rate**.
2. Enter the custom rate in **bps** (e.g. `2300` = 23%) and a reason; enter your
   password (FINANCIAL step-up); apply.
3. The affiliate becomes `STRATEGIC` and is excluded from auto-tiering. To clear the
   override, submit a blank custom rate (falls back to tier).

## Run maturity / re-tier (normally scheduled)
- Affiliate 360 or Affiliates page → **Maintenance jobs**:
  - **Run commission maturity** → `matureCommissions` (idempotent).
  - **Recalculate tiers** → `recalcAllTiers` (skips custom-rate affiliates).

## Approve and pay a payout
1. Affiliate 360 → **Payouts**.
2. **Approve** the requested payout.
3. Perform the real transfer out-of-band on your payout rail.
4. **Mark paid…** → enter the external reference, method, and (optional) evidence
   reference; FINANCIAL step-up; confirm. This posts the `PAYOUT_PAID` ledger debit.
   *Never mark paid before the transfer actually settled.*
- **Cancel / Fail** return the funds to withdrawable.

## Correct a balance
- Affiliate 360 → **Actions → Commission adjustment**. Enter a signed micros amount,
  a reason code, and an explanation; FINANCIAL step-up. This is the only balance
  correction path; it is append-only and can go negative.

## Suspend / terminate an affiliate
- Affiliate 360 → **Actions → Change status** → `PAUSED` / `SUSPENDED` / `TERMINATED`
  with a reason. Their codes stop resolving and stop earning immediately.

## Change program economics
- See doc 12. Config edits are versioned and audited; historical commissions are
  unaffected.

## Handle a refund / chargeback
- Automatic: `commerce-refund.ts` reverses the commission on refund and on a
  chargeback opening (idempotent). No manual step is required; verify the reversal in
  the affiliate's ledger/360 if investigating.

## Model a proposed rate/threshold change
- Run `pnpm --filter @atlas/server affiliate:economics --affiliates 500 --months 12
  --report <path>` to estimate liability before shipping a config change (doc = the
  economics stress report).

## Investigate a self-referral flag
- Affiliate 360 → **Risk signals**. A `SELF_REFERRAL_ATTEMPT` records the order and
  whether it matched by user or identity. The commission was denied automatically.
