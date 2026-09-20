# Atlas — Owner Control Center V2 plan

Baseline: `4fdfea9` (V1 shipped). Working tree clean, remote = local, 42 test
files / 744 tests green.

V1 ended with an honest list of what was *not* done. V2 starts there. This
plan is not 76 phases of new surface — it is a short list of the things that
would actually stop a real prop-firm operator from running Atlas, built for
real and measured for real. The standing rule from every prior milestone
holds: **do not fake it, measure it, report the actual weaknesses.**

## Where V1 left off (the disclosed weaknesses, verbatim intent)

1. **No product editor.** The versioned-publish backend exists and is
   immutable at the DB level, but the only way to publish is a raw API call
   with a hand-built config. No draft, no field-level change preview, no
   version history in the UI, no deactivate button.
2. **Not proven at scale.** Traders/Accounts lists paginate server-side but
   were never loaded past a handful of rows. No 1k/10k measurement, no p50/
   p95/p99, no virtualization decision made from data.
3. **Trading/Risk value synchronously per request.** Fine at a few hundred
   in-trade accounts; unproven under load. No read model, no staleness
   marker.
4. **Concurrency defined by the account mutex but not exhaustively tested.**
   Owner-vs-owner and owner-action-vs-execution races are asserted in code,
   not in tests.
5. **No owner-action torture harness.** Critical invariants were covered by
   the admin suite + execution torture; there is no dedicated owner fuzzer.

## What V2 builds (real code)

### A. Product Configuration — the flagship

The immutable-version core already guarantees the hard part: publishing
version N+1 never touches version N, and an account pinned to version N keeps
its terms (DB trigger `profile_versions_no_update` raises on any UPDATE). V2
gives an operator the actual workflow on top of that guarantee:

- **Draft.** A product edit is composed as a draft (persisted, not a version).
  A draft is mutable; a version is not. Publishing a draft writes version N+1
  and clears the draft.
- **Change preview / compare.** Before publishing, show a field-level diff of
  the draft against the current published version — every changed rule, old →
  new. Compare any two versions the same way.
- **Version history.** The full list of published versions with who/when/notes,
  newest first, each inspectable.
- **Deactivate / reactivate.** Toggle `status` ACTIVE↔RETIRED. Retiring stops
  *new* provisioning; it must never touch existing accounts. Audited.

**The proof that matters:** a server test provisions Account A from product P
v1, publishes P v2 with materially different terms, and asserts Account A's
resolved config is *still v1*. This is the one invariant the whole product
system exists to protect, and V2 makes it a red/green test.

### B. Scale — measured, not asserted

- A **legitimate fixture generator** that inserts N real traders + accounts
  (real rows, real org, hashed passwords) — 1k and 10k.
- **Measured latency** for the Traders list, Accounts list, and search at
  1k/10k: p50/p95/p99 from actual requests, written into the report as
  numbers.
- **Pagination verified** to bound work regardless of dataset size (the list
  endpoints already `limit`; confirm they page and that search stays cheap).
- Virtualization decision made *from the measurement*, not before it.

### C. Concurrency — tested, not assumed

- Owner-vs-owner: two simultaneous holds / two publishes race cleanly.
- Owner-action-vs-execution: hold vs a working order; the account mutex is the
  arbiter and the audit chain must stay intact.
- These become tests, with the outcome recorded honestly.

### D. Production safety re-test

Confirm, on the actual config code, that production behavior has: no dev-secret
acceptance, no wildcard CORS, no seeded owner credentials silently enabled.
Seed/demo credentials are development-only. Re-tested and stated.

## Explicitly NOT in V2 (unchanged constraints)

No payments/payouts/affiliates/promotions/discounts/marketing/revenue/CRM/
support-ticketing/white-label. No Databento, no DOM/L2, no alerts, no
backtesting, no AI trading, no news/social/leaderboard. No new drawing-tool
families, no indicator expansion. Scale is **measured**, never faked.

## Honest scoping

The V2 brief lists ~76 phases. This plan does not pretend to execute all of
them at equal depth in one turn. It builds the flagship (Product Config) to
completion, measures scale on real fixtures, tests the concurrency invariants,
re-checks production safety, and — per the standing instruction — reports the
weaknesses that remain rather than dressing green tests as "done." The report
at the end is the deliverable that must not be sanitized.
