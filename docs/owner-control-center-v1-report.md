# Atlas — Owner Control Center V1 completion report

Final commit: pushed to `claude/futures-trading-simulator-v8qefu` (hash in the
chat summary). Baseline `d5bc19b`. Working tree clean, remote = local.

## The honest shape of this milestone

Atlas already had most of an owner console: a real, role-gated `/admin` app and
API with Overview, Users, Accounts + detail, the full account lifecycle,
centralized provisioning, immutable product versions, and hash-chained audit.
Building a parallel "control center" would have duplicated working, tested
infrastructure. So V1 **extended** the existing owner shell, added the three
genuinely-missing operational views, refocused the vocabulary to the owner's,
and tested it hard. Nothing was rebuilt to inflate the diff; nothing is faked.

## What was delivered

* **Trading surveillance** (`GET /admin/trading` + page): firm-wide open
  positions, working orders, recent fills, each joined to trader + account.
  Positions are **valued by the engine**, never re-derived in the route (the
  positions table stores cost basis, not a mark; inventing the mark is the money
  bug the diagnostics milestone existed to catch). Only accounts holding a
  position are valued, so cost is bounded by open exposure. Tabbed UI with a
  client filter; unknown marks render "—", never a fake zero.
* **Risk** (`GET /admin/risk` + page): four factual panels — accounts nearest a
  loss limit (least remaining drawdown first), largest open loss (most negative
  first), on admin hold, recent failures. Every ordering is a stated fact; there
  is no opaque risk score. Ranked lists cover accounts with open exposure — a
  flat account has no open risk to be near a limit with.
* **System** (`GET /admin/system` + page): API / Database / Market data / Audit
  health, told honestly. The market row is DELAYED / DEGRADED / OFFLINE from the
  provider's own connection state and freshness — never HEALTHY while the feed
  is stale or blocking order entry. The delayed feed is stated as delayed.
* **Nav refocus:** Overview / Traders / Accounts / Trading / Risk / Products /
  System. "Users" is now "Traders"; the `/admin/users` path still resolves so
  old links work.
* **Seeded operator:** `owner@atlasfutures.local` / `atlas-owner-2026`
  (SUPER_ADMIN) — a firm needs one super-admin seat to exist.

## Verified against the V1 success condition

The seeded owner can, on authoritative server state: see the firm (Overview) →
find a trader (Traders search) → inspect (trader/account detail) → grant an
account (provisioning, idempotent, audited) → inspect trading (surveillance) →
control access (hold/reset/disable, each with reason + audit) → inspect risk →
read product versions → trace audit (hash-chain verified) → verify system
health. All of this existed or was added this milestone.

## Test results

* **Unit + server:** 42 files, **744** tests (was 735 at V3; +5 new owner
  endpoint tests, +4 carried from V3's drag threshold). Admin suite 30 → **35**.
* **New admin tests prove:** a trader is refused `/trading`, `/risk`, `/system`;
  SUPPORT reads them scoped to its own firm and other-org accounts never appear;
  risk loss-ordering is monotonic; System never reports HEALTHY while the feed
  blocks order entry; all three refuse with no token.
* **Execution reconciliation (Phases 57–59):** exec-torture, 120 operations,
  all nine operation types, 75 with a position open, 0 refusals, **0 invariant
  failures**, no page errors — balance/realized/unrealized/positions/orders/fees
  reconcile across the full lifecycle.
* **Idempotency (Phase 60):** execution-safety 16/16 (double-click sends one
  order); provisioning carries an idempotency key, tested in the admin suite.
* **Typecheck:** web and server clean.
* **Endpoints verified live** as the seeded owner: overview/trading/risk/system
  all 200; system correctly reported market data DEGRADED.

## Security (Phases 43–45, 82)

Every new endpoint is under the existing `requireRole('SUPPORT')` group and
filters by `organizationId = organizationOf(user)`. Cross-org rows cannot appear
in trading/risk (tested). No production-secret / CORS / refresh regressions —
those files were untouched. The new endpoints are read-only; no new mutation
surface was added.

## Honestly deferred / not done (do not mistake green tests for "done")

* **Product editing UI with change-preview (Phases 38–39):** the versioned
  publish backend exists and is exposed; a visual editor with a field-level diff
  is deferred. Publishing remains available via the API.
* **10k-row virtualization (Phase 48):** lists paginate server-side; a
  virtualized table is deferred until dataset size demands it. Not stress-tested
  at 10k.
* **Owner-action torture harness (Phase 61) and the full 150+150 manual
  matrices:** covered the critical invariants with the admin suite + execution
  torture; the exhaustive manual matrices and a dedicated owner-action fuzzer
  are deferred.
* **Owner/trader concurrency matrix (Phase 62), iPad pass (Phase 65),
  large-dataset latency lab (Phases 66–67), full visual-regression baselines for
  all 12 owner screens (Phase 80):** not performed this turn. The pages use the
  same shared table/panel kit already covered by responsive work, but I did not
  re-measure them at every breakpoint.
* **Execution feedback state-machine polish (Phases 53–56):** the execution
  lifecycle and confirmed-fill audio already exist and were left as-is; I ran
  the reconciliation track but did not add new feedback states.
* **No fake business systems** (payments/payouts/affiliates/etc.), no Databento,
  no trader-feature expansion — all correctly absent.

## What I would not yet call production-ready for a real operator

* Trading and Risk value accounts-with-positions synchronously per request. At
  a few hundred concurrently-in-trade accounts this is fine; at firm scale it
  needs a cached/streamed valuation path. Measure before trusting it under load.
* The owner pages have not been load-tested at 1k–10k accounts, nor given a
  full a11y/keyboard and iPad pass. They are correct and safe, not yet proven
  fast at scale.
* Destructive account actions (hold/reset/disable) are the existing, audited
  flows surfaced in the UI; the owner-action concurrency races (Phase 62) are
  defined in code by the account mutex but not exhaustively tested here.
