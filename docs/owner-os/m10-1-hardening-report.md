# Milestone 10.1 — Owner OS Hardening, Torture & Repair — Report

## Purpose

Verify every M10 claim, hunt for fake/unwired/unsafe surfaces, torture-test the
safety-critical paths, and repair what breaks. No new features; no destructive
production testing; `EXTERNAL_LIVE_ENABLED` stays `false`.

## §0 — M10 completion verified first

M10 shipped and is on the branch: 336 deterministic Owner OS tests across 19
suites, 85 browser acceptance scenarios, 16 docs + final report, all committed and
pushed (local == remote). Confirmed before starting the hardening pass.

## Verification matrix (§A) — is any surface fake, unwired, or unsafe?

- **Route registration** — all nine owner route modules (`owner-staff`,
  `owner-observability`, `owner-accounts`, `owner-config`, `owner-system`,
  `owner-alerts`, `owner-customers2`, `owner-io`, `owner-finance`) are registered
  in `app.ts`. ✅
- **Authorization** — every state-changing ops route is gated by
  `requirePermission` / `requireAnyPermission`. The only ungated POSTs are
  `/security/reauth` (re-verifies the password itself) and the invitation
  `/accept` (pre-account, token + rate-limited) — both correctly public. ✅
- **Reauth** — every high-risk endpoint carries the right step-up class:
  `accounts/:id/adjust` and `/disable` → FINANCIAL; kill-switch engage/release →
  KILL_SWITCH; staff invite/role/disable → STAFF. ✅
- **Truthfulness (§107)** — verified end-to-end in the browser: Rithmic
  `verified=false`, market-data instruments `NOT_VERIFIED`, external notification
  channels `NOT_CONFIGURED`, environment badge `SIMULATION`, System Doctor never
  claims Rithmic connected/verified. ✅

### Finding V-1 (fixed during M10) — Staff page called the wrong path

The Staff web page fetched `/api/v1/admin/ops/staff`; the staff routes are mounted
at `/api/v1/admin/staff`. The M10 browser acceptance suite caught it and it was
fixed before M10 was pushed. Re-verified here (Staff page renders, directory lists
staff).

## Torture pass (§B/C) — findings and repairs

Two real concurrency defects were found by the torture suites and **fixed** (P1 —
each defeated a stated guarantee):

### Finding H-1 (P1, FIXED) — Incident dedupe raced under concurrency

`openOrGroupIncident` did a check-then-insert with no atomic guard. 30 concurrent
opens on one dedupe key created **30** incidents, defeating the core "one incident,
not hundreds" guarantee that exists precisely for concurrent storms.

**Fix:** the dedupe path now runs inside a transaction behind a per-key
`pg_advisory_xact_lock`. 30 concurrent opens now collapse to **exactly one**
incident. The identical `raiseAlert` coalescing path was hardened the same way.

### Finding H-2 (P1, FIXED) — Feature-flag optimistic concurrency lost updates

`setFlag`'s conflict detection compared the caller's `expectedUpdatedAt` to the
row read before the write. Under true concurrency two writers read the same value
and **both** succeeded — a silent lost update.

**Fix:** `setFlag` now issues a conditional `UPDATE ... WHERE id = ? AND
updated_at = ?` guarded by the pre-image timestamp and reports `FLAG_CONFLICT`
when the guard does not match. Exactly one concurrent writer wins; the other is
refused. (The everyday "two admins minutes apart" case was already covered; this
closes the same-instant race.)

### What held up (no defect)

- **Money safety** — the `admin_adjustments` ledger is genuinely append-only: the
  DB trigger refuses UPDATE and DELETE (single-row and bulk). Adjustments fail
  closed on missing amount / short explanation / unknown account; METADATA never
  moves the net; 30 concurrent credits/debits all persisted and the net was exact;
  the raw balance column is never mutated. ✅
- **RBAC red-team** — the full deny matrix holds: 401 unauthenticated, 403 without
  permission, correct reads allowed; DENY beats role on the live request; a GRANT
  is scoped to one permission; an ADMIN cannot self-grant (the override endpoint is
  owner-only); a TRADER reaches nothing. ✅
- **Step-up & impersonation** — a token never satisfies a different class or user,
  a tampered/empty token never verifies, every reauth class round-trips and
  cross-class-rejects; impersonation refuses self / staff / unknown targets,
  requires a reason, blocks every forbidden action in both modes, and a
  garbage/expired token returns null (fails closed). ✅
- **Kill switches** — engage fails closed (423 at the seam), requires a reason,
  double-engage is idempotent, a burst of concurrent releases converges to
  released. ✅
- **Audit chain** — verifies end to end after heavy write load; the
  `INV_AUDIT_CHAIN_INTACT` invariant passes. ✅
- **Search & inspectors** — hostile input (SQL-shaped strings, path traversal,
  XSS, huge strings, emoji, whitespace) returns safe grouped results and never
  throws; inspectors and money-trace fail closed on unknown ids; the object
  explorer refuses unsupported types instead of dumping rows and never leaks
  password material. ✅

## Also improved

- `REAUTH_CLASSES` is now a single exported source of truth in `permissions.ts`
  (was duplicated in `owner-staff.ts`), with `ReauthClass` derived from it.

## Test evidence

- **Deterministic M10.1 tests: 162** across 5 suites (target ≥150), all green:
  - `m10-1-rbac-redteam.test.ts` — authorization matrix + escalation attacks
  - `m10-1-money-safety.test.ts` — append-only ledger + fail-closed + net exactness
  - `m10-1-torture.test.ts` — kill switches, flag OCC, alert/incident storms, audit chain
  - `m10-1-reauth-impersonation.test.ts` — step-up + impersonation adversarial
  - `m10-1-inspectors-adversarial.test.ts` — hostile search/explorer/inspector input
- **Browser hardening scenarios: 83** (`m10-1-hardening.spec.mjs`, target ≥75), all
  green — unauth rejection across 20 ops reads, owner served across all, truthful
  state surfaces, invariants + kill switches present, step-up refusals, money-safety
  refusals, console rendering.
- **Regression** — the M10 suites touched by the fixes (alerts, config, incidents,
  command-center, owner-config-http) stay green.

## Safety posture (held)

`EXTERNAL_LIVE_ENABLED` remains `false`; no real trades, money movement, or card
charges. No destructive production testing was performed — the torture suites run
against isolated test orgs and the browser pass engages no order-blocking or
broad kill switch. Locked product rules are untouched.

## Environment note (not a product defect)

The shared local `atlas_test` database accumulates rows across repeated full-suite
runs; two pre-existing firm-wide-aggregation tests (`owner-exposure`, the admin
audit-chain concurrency case) are sensitive to that accumulation and can report
stale counts after many local runs. They pass on a fresh database (CI). This is a
test-isolation property of those older suites, unrelated to M10/M10.1 code, and is
recorded here for transparency; a follow-up could scope them to a per-run org.

## Status

M10.1 complete: verification matrix clean, two P1 concurrency defects found and
fixed, 162 deterministic + 83 browser hardening tests green, report delivered.
