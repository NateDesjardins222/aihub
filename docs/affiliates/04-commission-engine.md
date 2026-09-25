# 04 — Commission engine

The commission engine turns a settled commercial order into exactly one
commission, snapshots everything that could change later, and moves money only
through the append-only ledger.

## Exactly-once

`processConversion(db, { orderId, sessionRef?, explicitCode?, discountMicros?, isReset? })`:

- Takes a **per-order advisory lock** (`pg_advisory_xact_lock(classId,
  hashtext(orderId))`) inside a transaction.
- Inserts the conversion with `onConflictDoNothing` on the unique
  `commercial_order_id` index. If the row already exists, it returns
  `created: false` and never double-commissions.
- Result: five parallel calls create exactly one commission (proven in
  `affiliate-commission.test.ts`).

## What it refuses

`ORDER_NOT_FOUND`, `ORDER_NOT_SETTLED:<status>`, `ORDER_REFUNDED`,
`NOT_QUALIFYING:COURTESY` (non-purchase source when courtesy is off),
`NOT_QUALIFYING:RESET` (reset when reset policy is `NONE`), `NO_ATTRIBUTION`,
`AFFILIATE_NOT_FOUND`, `AFFILIATE_NOT_ACTIVE:<status>`, `SELF_REFERRAL_DENIED`,
`NO_REVENUE`.

## The snapshot (historical immutability)

When a commission is created it records, immutably:

- `qualifiedRevenueMicros` — the net (or gross) basis amount,
- `rateBps` and `rateSource` — the applied rate and where it came from
  (`TIER` / `CUSTOM` / `RESET_REDUCED`),
- `tierAtEvent`, `productVersionId`, `configVersion`,
- `maturityAt` — `completedAt + commissionMaturityDays`.

**Changing a rate or config tomorrow never rewrites yesterday's commission.**
Proven in `affiliate-economics.test.ts`: after `changeAffiliateRate`, the existing
commission's `rateBps`/`commissionMicros`/`configVersion`/`maturityAt` are
unchanged, while a *new* conversion uses the new rate.

## The math

`commissionMicrosFor(qualifiedMicros, rateBps)` = `Number(BigInt(qualified) *
BigInt(rateBps) / 10_000n)` — integer, floors, no float error. Examples:
`$100 @ 1750bps = $17.50` exactly; `999999 micros @ 1750bps = 174999` (floored).

## Maturity

`matureCommissions(db, org, now?)` moves `TRACKED`/`PENDING` commissions whose
`maturityAt <= now` to `PAYABLE` and posts a `COMMISSION_MATURED` ledger entry
(the signed amount that makes the balance available). It is **idempotent**:
running it twice does not double-credit (per-row status guard).

## Balances (see doc 06)

`affiliateBalance` derives every figure from the ledger. `availableMicros` is the
raw sum of all ledger amounts — an invariant asserted directly in tests.
