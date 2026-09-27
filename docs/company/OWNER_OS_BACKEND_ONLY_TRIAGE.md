# Owner OS — backend-only family triage (Product Recovery Phase 3, STEP 11/12)

**Question:** which Owner OS capabilities exist only as backend routes with no console UI,
and which of those are LAUNCH-CRITICAL (must be wired now) vs POST-LAUNCH / INTERNAL / DEAD?

**Method:** enumerated every registered owner route group (`apps/server/src/http/routes/owner-*.ts`,
`admin.ts`, `payout-ops.ts`) and cross-checked each family against the console pages that call it
(`apps/web/src/admin/**`). A family is "wired" when an operator can reach it from the console without
the API or a developer.

**Result:** the trading/money/lifecycle CORE is fully operable from the console. The one true launch
gap Phase 2 flagged — **staff management UI** — is now built (see `StaffPage`, this phase). Every
remaining backend-only family is observability, ops-productivity, or diagnostics: **POST-LAUNCH or
INTERNAL, none LAUNCH-CRITICAL.** Nothing else needs wiring for launch.

Classification legend: **LAUNCH-CRITICAL** (owner cannot run the business without it) ·
**POST-LAUNCH** (real value, not blocking a beta launch) · **INTERNAL** (operator/developer
diagnostics) · **DEAD** (no longer referenced).

## Already wired (core owner operations — NOT backend-only)

| Family | Console surface |
|---|---|
| Customers directory + Customer 360 + tags | Customers page, Support tag control |
| Account ops: preview / adjust / pause / resume / disable / enable | Account page |
| Provisioning exceptions + retry | Customers / Command Center attention |
| Funding decisions | Funding page |
| Payouts: request / approve / reject / processing / paid + Payout Ops | Payouts, Payout Ops pages |
| Products / config / versions | Products, Product pages |
| Feature flags + kill switches (+ step-up) | System page (Ops System) |
| Enforcement holds / cases | Enforcement page |
| Support inbox / tickets / remediation / refunds | Support pages |
| Affiliates program + Affiliate 360 | Affiliates pages |
| Risk & trading surveillance | Risk, Trading pages |
| System Doctor / Integrity / Reconciliation / Jobs / Incidents / Alerts / Providers | System page |
| Audit explorer (hash-chained) + verify | Audit page |
| Economics + M13 simulator | Economics pages |
| Provider health / infrastructure / market-data mode | Infrastructure page |
| Certificate store | Certificate Store page |
| **Staff & access: invite / role / disable / reactivate / revoke sessions (+ step-up)** | **Staff page (built this phase)** |

## Backend-only families (no dedicated console control) — triage

| # | Family (routes) | Classification | Rationale / where the need is already met |
|---|---|---|---|
| 1 | `ops/system/full-test` + `ops/system/results` | INTERNAL | Aggregate self-test; the System page already surfaces Doctor + Integrity + Reconciliation, which are the operator-facing pieces. Full-test is a diagnostic run for engineering. |
| 2 | `ops/system/inactivity-sweep` | POST-LAUNCH | HTF-18 closure runs **automatically** (`InactivityWorker`, scheduled in `app.ts`). A manual "run now" button is convenience, not required for launch. |
| 3 | `ops/config/changes` | POST-LAUNCH | Config change-management log. The Audit explorer already lets an operator find config mutations by action/subject; a dedicated change feed is a productivity add. |
| 4 | `ops/alerts/channels` + `ops/alerts/subscriptions` | POST-LAUNCH | Alert **routing** configuration. Alerts themselves are visible/ack/resolve on the System page; routing is ops tuning done rarely. |
| 5 | `ops/daily-brief` | POST-LAUNCH | A rolled-up daily summary; the live Command Center covers the operator's at-a-glance need. |
| 6 | `ops/search` + `ops/events` + `ops/correlation/:id` | POST-LAUNCH | Global event search / correlation (M10-C). Overlaps the wired **Audit explorer** (`/audit`), which already gives operators filtered, hash-chain-verified search. The `/ops` global search is a superset for cross-object investigation. |
| 7 | `ops/inspect/payout/:id` + `ops/inspect/account/:id` | INTERNAL | Deep object inspectors (state-probe style). Operator needs are met by Customer 360 + Account pages; these are engineering deep-dives. |
| 8 | `ops/objects/:type/:id` | INTERNAL | Generic object viewer for investigation; same as #7. |
| 9 | `ops/finance/summary` + `ops/finance/money-trace/payout/:id` | POST-LAUNCH | Finance summary + money trace. The payout ledger + Payout Ops already show per-payout accounting; a consolidated money-trace view is a finance-team add. |
| 10 | `ops/exports` + `ops/views` + `ops/notes` + `ops/tasks` | POST-LAUNCH | Owner finance workspace (saved views, CSV exports, sticky notes, task list). Pure ops productivity; agreements/notes partially surface via Customers. |
| 11 | `ops/webhooks` | POST-LAUNCH | Webhook delivery monitor. The Jobs/Queues panel on the System page already exposes queue health (queued/delivered/dead-letter/retrying). |
| 12 | `ops/execution-quality` | POST-LAUNCH | Execution-quality metrics (slippage/latency analytics). Not needed while EXTERNAL_LIVE is off (simulation); relevant when real execution goes live. |
| 13 | `ops/agreements` | POST-LAUNCH | Versioned agreement acceptances; partially surfaced in Customer views. A dedicated agreements admin is a compliance productivity add. |

## Conclusion (STEP 12)

- **LAUNCH-CRITICAL backend-only families: none remain.** The staff-management UI — the sole
  launch-critical gap named in the Phase 2 report — is built this phase.
- **No new UI is wired for launch beyond Staff**, because nothing else in the backend-only set gates
  running the business: each is observability, ops-productivity, or diagnostics.
- **Owner can operate the core without dev tools:** customers, accounts (pause/hold/adjust),
  funding, payouts, products/config, kill switches, holds, support, affiliates, risk/trading
  surveillance, audit, economics, provider health, certificates and staff are all reachable from the
  console. The `owner-os-acceptance` browser suite and `HUMAN_GOLDEN_PATH.md` exercise this end to end.
- **DEAD families: none found** — every backend route group is still referenced by the server and has
  a live purpose.

The POST-LAUNCH / INTERNAL families are recorded here as the backlog for the Owner-OS quality
sub-phase; they are deliberately NOT wired now to keep Phase 3 scoped to closing behavioral gaps.
