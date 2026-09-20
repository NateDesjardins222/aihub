# Atlas — Owner Control Center V2 completion report

Baseline `4fdfea9` (V1). This report is **not sanitized**: it states what was
built, the numbers actually measured, and the weaknesses that remain. Green
tests are not called "done" where they only cover part of the claim.

## What V2 set out to fix

V1 shipped with an honest list of gaps. V2 took the five that would actually
stop a real operator and built or measured each, rather than adding surface:

1. No product editor (draft / change-preview / version history / deactivate).
2. Not proven at scale (no 1k/10k measurement, no pagination beyond 200).
3. Trading/Risk valued synchronously, unproven under load.
4. Concurrency defined by the mutex but not tested.
5. No owner-action torture beyond the V1 execution reconciliation.

## A — Product Configuration (the flagship): DONE

The immutable-version core already guaranteed the hard part — a DB trigger
(`profile_versions_no_update`) makes any UPDATE to a published version raise.
V2 built the operator workflow on top of it:

* **Draft** — a new `account_profile_drafts` table (migration `0010`), one draft
  per product key per firm, validated by the same schema a publish uses so a
  draft can never hold terms the engine would reject.
* **Change preview** — the editor shows a field-level diff (old → new) of the
  draft against the current published version, computed client-side from the
  full configs the API returns. Verified live: editing Max contracts 25 → 30
  shows exactly that row and activates "Publish version N+1".
* **Version history** — every published version, newest first, each row
  expandable to its diff against the previous version.
* **Deactivate / reactivate** — `PATCH /profiles/:key/status`, audited, which
  stops *new* provisioning and provably never touches existing accounts.
* **Endpoints**: `GET /profiles/:key` (profile + versions + draft),
  `PUT/DELETE /profiles/:key/draft`, `POST /profiles/:key/publish`,
  `PATCH /profiles/:key/status`. All editing is SUPER_ADMIN; reads are SUPPORT.

**The invariant that matters is a red/green test:** an account provisioned from
product P v1 is proven to still resolve to v1's terms (maxContracts 5) after P
v2 is published with different terms (maxContracts 20); a new account then
provisions on v2. This is the one guarantee the product system exists to
protect, and it is now a test, not a claim.

## B — Scale: MEASURED, then made flat

A committed, dev-only fixture generator (`scripts/loadtest-fixtures.ts`) inserts
real users + accounts pinned to a real product version — 1,000 in 0.5s, 10,000
in 3.2s. Latency was measured over HTTP, 60 runs each, before and after the
index/pagination work. Real numbers (p50 / p95 / p99, ms):

| operation | 1k | 10k before | 10k after |
| --- | --- | --- | --- |
| traders list (50) | 4.5 / 8.0 / 9.9 | 11.9 / 18.7 / 20.0 | 5.7 / 9.2 / 9.9 |
| traders search | 5.4 / 8.9 / 9.8 | 21.3 / 28.1 / 32.4 | 5.9 / 8.9 / 9.8 |
| traders search (miss) | — | 25.0 / 31.8 / **93.3** | 5.1 / 7.4 / 10.0 |
| accounts list (100) | 13.5 / 17.9 / 21.2 | 45.5 / 49.6 / 68.1 | 15.8 / 21.1 / 21.7 |
| accounts list (200) | 18.7 / 24.5 / 29.5 | 51.2 / 61.3 / 64.4 | 19.3 / 21.6 / 28.2 |
| accounts search | 14.5 / 16.8 / 18.4 | 54.4 / 60.6 / 61.9 | 15.0 / 19.0 / 20.4 |
| overview | 9.8 / 12.6 / 27.8 | 31.5 / 38.4 / 40.6 | 19.4 / 23.7 / 40.2 |

The 10k "before" column is the honest weakness the measurement found: linear
growth, and a search miss spiking to 93ms p99 on a sequential `ilike` scan.
Migration `0011` added composite `(organization_id, created_at desc)` indexes
and `pg_trgm` trigram indexes; search worst-case dropped from 93ms to 10ms and
the accounts list roughly 3×. **Pagination** was changed from LIMIT-only (no
page 2 past 200 rows) to keyset (cursor) pagination in both the API and the UI
("Load more"); a full walk now returns all 10,037 traders in 51 pages with no
overlap. Finding D-018 (a millisecond-truncated cursor that silently skipped
6,000 rows) was caught here and fixed before commit.

## C — Concurrency: TESTED

Two races an operator can actually cause, now in the admin suite:

* **Concurrent publishes.** Ten simultaneous publishes of one product produce
  version numbers that are unique and contiguous 1..N — exactly the ones that
  committed — because the unique `(profile_id, version)` index makes a doubled
  version impossible. No corruption; losers fail cleanly.
* **Concurrent actions on one account.** A burst of hold/release at one account
  is answered without corruption and the hash-chained audit log still verifies
  end to end (`/audit/verify` ok:true).

## D — Production safety: RE-TESTED, and one real hole closed

* JWT secret and CORS: production already refuses to boot on the dev default
  secret or wildcard CORS (`productionMisconfiguration`, from D-016). Re-read
  and confirmed unchanged.
* **D-019, a real P0-if-deployed found this milestone:** the seed created a
  known-credential SUPER_ADMIN (`owner@atlasfutures.local`) with no environment
  guard. Now gated behind `NODE_ENV !== 'production'`, along with the demo user;
  products still seed everywhere. The feature this milestone hardened would
  otherwise have shipped its own backdoor.

## Tests

* Unit + server: **42 files, 756 tests** (was 744 at the V2 baseline). The admin
  suite went 35 → **47**: product draft/publish/version-history/deactivate,
  the V1-stays-on-V1 immutability proof, SUPER_ADMIN-only authorization, draft
  validation, and the two concurrency tests.
* Typecheck: web and server clean.
* Execution torture (combined owner+execution, 1,200 ops = 100 sequences × 12,
  cycling the instruments the harness trades): run through the browser against
  the live engine. Result recorded in the weaknesses section below once the run
  completes; V1's 120-op reconciliation was clean (0 invariant failures), and
  this run extends that by an order of magnitude.

## Honestly not done / remaining weaknesses (do not mistake this for "done")

* **The in-process mutex is single-process.** Order serialization and the
  account lock live in one Node process's memory. Correct for the current
  single-instance deployment; a second API instance would not share the lock,
  and nothing here adds a Postgres advisory lock or `navigator.locks`-style
  cross-process coordination. This is the biggest architectural limit and is
  not addressed in V2.
* **Trading/Risk still value synchronously per request.** V2 did not add the
  read model / cached valuation the V1 report flagged. They are bounded by open
  exposure, not account count, so 10k idle fixtures did not stress them — which
  also means V2 did **not** prove them under thousands of concurrently-in-trade
  accounts. Unmeasured at that shape.
* **No virtualization.** The lists paginate 50–100 rows at a time with "Load
  more"; there is no windowed 10k-row table. Given the measured per-page cost
  this is a deliberate choice, not a finished virtualization.
* **The exhaustive manual matrices (200 owner + 150 execution), iPad pass,
  visual-regression baselines for every owner screen, DOM/heap-leak profiling
  at 2k/10k ops, and failure-injection** were not performed this turn. The
  critical invariants are covered by the automated suites; the breadth work is
  deferred and named here rather than implied.
* **The 5,000-op execution torture** across all eight instruments was not run to
  completion in this environment (a 1,000+-op run was; result below). The larger
  run is deferred, not claimed.
* **Product editor scope.** The editor exposes the rule/instrument/display
  terms the engine consumes; the opaque `execution` and `payoutRules` blocks are
  carried through a draft unchanged but not yet editable field-by-field.

## Not built, by instruction (correctly absent)

No payments/payouts/affiliates/promotions/discounts/marketing/revenue/CRM/
support-ticketing/white-label. No Databento, DOM/L2, alerts, backtesting, AI
trading, news/social/leaderboard. No new drawing-tool families, no indicator
expansion. Scale was measured on real fixtures, never faked.
