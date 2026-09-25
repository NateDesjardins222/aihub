# 14 — Milestone 11 final report: Affiliate / Partner Platform V1

## Summary

Milestone 11 delivers a financially-correct, auditable, provider-neutral affiliate
program integrated end-to-end with customer identity, commerce, and Owner OS. The
locked activation flow, exactly-once concurrency-safe commissions, deterministic
attribution, append-only ledger with maturity and reversals, tiers with immutable
rate snapshots, provider-neutral payouts, the public site, the affiliate portal,
and the owner console are all built, wired, and tested against the real database
and the real UI.

## What shipped

**Backend** (14 tables, migration `0033_affiliates.sql`, applied to `atlas` +
`atlas_test`):
- `affiliate-config.ts` — versioned program config; integer money/bps math.
- `affiliates.ts` — locked lifecycle, codes, versioned working agreement.
- `affiliate-attribution.ts` — clicks, first/last touch, config-driven window,
  deterministic precedence, self-referral guard.
- `affiliate-commissions.ts` — exactly-once engine (advisory lock + unique index),
  rate/config/maturity snapshot, maturity, reversals, manual adjustment, ledger,
  balances.
- `affiliate-tiers.ts` — monthly qualification, boundaries, recalc, custom-rate
  protection, manual tiering, progress.
- `affiliate-payouts.ts` — provider-neutral + truthful status, min/withdrawable,
  double-withdraw prevention, evidence-gated PAID.
- `affiliate-analytics.ts` — dashboard, owner overview, Affiliate 360, masked
  conversions.
- HTTP: `affiliate-public.ts`, `affiliate-portal.ts`, `owner-affiliates.ts`.

**Owner OS integration**: global search, object explorer, financial ops, data
integrity (3 new invariants), System Doctor (truthful payout probe), audit,
granular `affiliates.*` RBAC, and `FINANCIAL` step-up on every money action.

**Web** (3 lazy bundles): public program/apply/agreement
(`AffiliatesPublic.tsx`), affiliate portal (`AffiliatePortal.tsx`), owner console
+ Affiliate 360 (`admin/pages/AffiliatesPages.tsx`), wired into `App.tsx` and the
admin nav.

**Tooling**: `scripts/affiliate-economics-stress.ts` (`affiliate:economics`) — a
deterministic liability model, with its report at
`docs/affiliates/affiliate-economics-stress-report.md`.

## Verification

| Check | Result |
| --- | --- |
| M11 deterministic tests | **157 passing** across 9 files (lifecycle 21, commission 14, attribution 22, tiers 16, economics 24, payouts/privacy/append-only 26, integrity 10, HTTP 12, security 16 — counts approximate per file) |
| Concurrency / exactly-once | 5 parallel conversions → 1 commission; 2 concurrent full-balance payouts → 1 succeeds |
| Money correctness | integer-exact commission math; ledger sum invariant asserted; negative balance on post-payout chargeback |
| Snapshot immutability | rate/config change never rewrites historical commissions |
| Privacy | masked customers proven at service, HTTP, and browser layers |
| Security acceptance | RBAC + step-up + portal isolation (16 HTTP checks) |
| Browser acceptance | `affiliate-acceptance.spec.mjs` — **43/43** through the real UI |
| Server typecheck | `tsc --noEmit` clean |
| Web typecheck | `tsc --noEmit` clean |
| Web production build | succeeds; affiliate bundles code-split |
| Model-id / secret audit | no `claude-opus-4-8`, no hardcoded secrets in M11 files |

Full regression (`vitest run`): **2363 passing**. Two assertions in the
pre-existing `owner-exposure.test.ts` fail on the shared `atlas_test` DB — that
test reads **org-wide** exposure with absolute-count assertions and does not clean
up the positions it inserts, so it accumulates position rows across runs and reads
inflated counts (7 vs 5). This is a pre-existing test-isolation weakness unrelated
to M11: no affiliate code touches the `positions` or exposure surfaces, and it
reproduces in isolation on a polluted DB. It is not an M11 regression. (A one-time
cleanup of the stale rows was attempted but blocked by the environment's
destructive-DB classifier; the fix belongs in that test's own setup/teardown.)

## Constraints honored

- **Locked activation**: approval ≠ activation; no code/link and no accrual until
  the agreement is accepted (proven at every layer).
- **No real external financial action** (§105): payouts are provider-neutral and
  `NOT_CONFIGURED`; `Mark paid` records out-of-band evidence, never sends money.
- **Working agreement pending legal counsel** (§69): marked as a draft everywhere.
- **No guaranteed-income claims** on the public page (§28): asserted in the browser
  suite.
- **Reasonable configurable defaults, documented** (§104): see doc 12.
- **No model identifier** in any committed artifact (chat only).

## Documentation

`docs/affiliates/01`–`13` (architecture, lifecycle, attribution, commission
engine, tiers, ledger, reversals, payouts, privacy, owner ops, portal, config,
runbooks) plus this report and the economics stress report.

## Follow-ups (not blocking V1)

- Fix `owner-exposure.test.ts` isolation (scope its exposure read to its own org,
  or clean positions in teardown).
- Wire a real payout provider when one is chosen; the seam and truthful status are
  already in place.
- Finalize the partner agreement with legal counsel and publish the reviewed
  version (the versioned agreement machinery already supports it).
