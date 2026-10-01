# Customer System Certification

What `pnpm customer:certify` certifies, and — just as important — what it does NOT.

## The two halves

### INTERNAL SOFTWARE CERTIFIED

The customer business logic proven in THIS repository, against a non-production
Postgres:

- Purchase → identity → entitlement → account → portal → Atlas → owner → payout →
  certificate chains are connected and authoritative.
- Idempotency, ownership isolation, the 5-active cap, payout ledger single-debit
  and 5-cycle limit, exactly-once certificates/achievements, and the honesty
  (error ≠ zero) invariants hold under duplicates, concurrency, crash recovery,
  stale clients, IDOR and malformed input.
- Read-only integrity detectors surface provenance corruption without false
  positives and count every offender.

Proven by a fresh read-only integrity scan plus the customer-chain proof suites
(FAST: 8 suites; DEEP adds the concurrency/crash/torture tiers). The harness exits
nonzero if any gate fails.

### EXTERNAL PRODUCTION UNVERIFIED

The following are NOT connected in this environment and are NOT certified by this
harness. Their fail-closed seams are proven, but their live behaviour is not:

- Rithmic (real market data / execution)
- Whop production checkout/webhooks (sandbox/mock only here)
- The real payout rail (reported UNAVAILABLE — registry + treasury gate fail closed)
- KYC / identity verification provider (mock)
- Object storage (certificate artifacts)
- Email / SMS delivery (mock)

`customer:certify` prints the provider-safety snapshot so this boundary is explicit
on every run. **We never claim production verification.**

## Running it

```
pnpm customer:certify                      # FAST: integrity scan + fast chain suites
CUSTOMER_CERTIFY_DEEP=1 pnpm customer:certify   # DEEP: adds torture/crash/soak
pnpm customer:certify --json               # machine-readable report
```

Exit codes: `0` certified · `1` harness failed to run · `2` a gate FAILED · `3`
refused (target looks like production — the harness never targets production).

Requires a migrated non-production DB (e.g. `scripts/prepare-test-db.sh` against
`atlas_test`). The harness refuses when `NODE_ENV=production` or `DATABASE_URL`
names a production database.

## Human acceptance

This is automated, cross-system software certification. **Human acceptance remains
pending — Nathan decides.** Nothing here is claimed as human-approved or as
production-verified.
