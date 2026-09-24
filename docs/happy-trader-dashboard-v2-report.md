# Milestone 5 — Happy Trader Dashboard V2 + Trader Risk Controls V1 — Completion Report

Two joined deliverables on the existing Atlas / Happy Trader monorepo:

- **Happy Trader Dashboard V2** — a premium, server-authoritative redesign of the
  customer portal at `/portal`, on a real design system with a genuine light
  theme, a command center, premium account cards, a full account-detail view with
  interactive performance, a clear payout experience, and achievements.
- **Trader Risk Controls V1** — a server-authoritative personal risk-control
  system (ten controls) that can only make an account *more* restrictive,
  enforced on the normal order/risk path, surviving restart and multi-device,
  respecting copy trading, never loosening firm rules, and never stranding a
  position.

Everything below is implemented, tested and pushed on branch
`claude/futures-trading-simulator-v8qefu`.

## What shipped

### Dashboard V2 (`apps/web/src/portal/`)

- **Design system** — `theme.ts` (persisted dark/light, `data-pt-theme`),
  `Portal.css` (graphite + chrome + restrained-gold token system, tabular
  numerals, responsive, reduced-motion), `lib.tsx` (formatters + primitives:
  `Card`, `Money`, `Metric`, `Pill`, `Toggle`, `Skeleton`, `EmptyState`,
  `AccountPath`). See `happy-trader-design-system.md`.
- **Shell** — `PortalApp.tsx`: nav (Dashboard · Accounts · Payouts · Achievements
  · Billing · Support), a global account switcher, a persistent **Trade →**, a
  theme toggle, an avatar menu (Profile / Verification / Security / Notifications
  / Log Out), and pathname + hash routing.
- **Command center** — `DashboardPage.tsx`: authoritative KPI summary + premium
  `AccountCard`s with a drawdown band and the lifecycle path.
- **Accounts** — `AccountsPage.tsx`: presentation-only nicknames, archive /
  unarchive, reset.
- **Account detail** — `AccountDetailPage.tsx`: Overview / Performance / Controls
  / Rules / Activity tabs.
- **Performance** — `Performance.tsx`: interactive equity curve (1D/7D/30D/90D/
  ALL, hover crosshair + tooltip), P&L calendar with a day → trades drilldown,
  the metric registry, by-instrument breakdown. See
  `happy-trader-performance-analytics.md`.
- **Controls UI** — `ControlsView.tsx`: the ten personal controls, enable / value
  / lock, with live server-derived usage.
- **Payouts** — `PayoutModule.tsx` / `PayoutsPage.tsx`: authoritative eligibility,
  90/10 split, min/max, human reason sentences, request flow.
- **Handoff** — the terminal now consumes `/?account=<publicId>`
  (`state/session.ts`), owner-validated against the account list and consumed once.

### Trader Risk Controls V1 (server-authoritative)

- **Contracts** — `packages/contracts/src/personal-risk.ts` (ten control types,
  kinds, modes, reject reasons, view types) + ten `PERSONAL_*` reject reasons in
  `trading.ts`.
- **Schema** — `drizzle/0023_trader_risk_controls.sql` (migration index 23):
  `orders.opened_exposure`; tables `trader_risk_controls`,
  `trader_risk_control_events` (append-only audit), `trader_risk_day_state`.
  Additive only; applied and verified on `atlas` and `atlas_test`.
- **Pure evaluator** — `trading/personal-risk.ts`:
  `evaluatePersonalRisk(config, dayState, ctx)`, increasing-only, ordered gate,
  `withinWindow` (wraps midnight), `validateControlValue`, `isStricter`.
- **Order-path store** — `trading/personal-risk-store.ts`: config/day-state reads
  and fill folding, kept inside `trading/` so the engine takes no dependency on
  `platform/`.
- **Engine gate** — `trading/engine.ts`: after the firm gate returns null,
  `submitLocked` calls `checkPersonalRisk` (liquidation-bypass, short-circuit when
  no controls are enabled, equity valuation only when the drawdown control is on);
  `matchLocked` folds fills into the day state, counting an opening trade once via
  `orders.opened_exposure`.
- **CRUD** — `platform/personal-risk.ts`: `getPersonalRiskProfile` (with live
  usage) and `upsertPersonalControl` (validation, locked-mode tighten-only,
  version CAS under `FOR UPDATE`, audit after commit).
- **HTTP** — `GET/PUT /api/v1/portal/accounts/:id/controls[/:type]` and
  `GET .../trades`, all owner-scoped.
- **Owner console** — `admin` account detail surfaces the controls **read-only**
  (no loosen/disable backdoor); observability rides `risk_events` (`rule =
  PERSONAL_*`).

## The hard constraints, and how they hold

- **No second engine.** The gate is a single hook after the firm `checkOrder`; it
  reuses `increasingQty`, `accountTradingDate()`, the fill counters and the
  existing audit/risk-event plumbing.
- **Effective = min(firm, personal).** Personal controls only *add* rejections;
  they never widen a firm limit. Firm rules, MLL, lifecycle, execution and
  provider safety are untouched.
- **Only exposure-increasing orders are blocked.** The gate acts on the
  increasing portion only; reduce / flatten / protective / cancel are never
  blocked — a position can never be stranded.
- **Locked = tighten-only, server-enforced.** A locked control cannot be loosened
  or disabled through the direct API until the next trading day; it can still be
  tightened. Proven in unit tests and end-to-end through the real HTTP API in the
  browser suite.
- **Browser never enforces risk or forges ownership.** All enforcement is
  server-side; every portal read/write is owner-scoped; an unowned id is denied
  (no IDOR).
- **Owner views read-only.** No operator path loosens or disables a trader lock.
- **No new products.** Exactly the ten existing products; business rules (5 active
  accounts, 90/10 split, 5 payout cycles → COMPLETED) preserved.
- **Never fabricate financial values.** Loading skeletons and honest empty states
  everywhere; sparse data is shown as sparse.
- **Additive migrations only.** 0023 adds one column and three tables.

## Testing

Deterministic torture / behavioural cases for the risk system (58, exceeding the
≥40 bar):

| File | Cases | Focus |
| --- | --- | --- |
| `trading/personal-risk.test.ts` | 37 | Pure evaluator: every control, increasing-only, ordering, window-wrap, validation, isStricter |
| `trading/personal-risk-gate.test.ts` | 10 | Engine integration on the real order path |
| `platform/personal-risk.crud.test.ts` | 10 | CRUD: validation, locked tighten-only, version CAS |
| `platform/copy-personal-risk.test.ts` | 1 | Copy-trading × personal-risk isolation |

Regression (all green, run in isolation): engine 58/58, rules.integration 14/14,
copy suite 37/37, portal + payout routes 40/40, lifecycle / funding / provisioning
34/34, web unit 265/265. Server and web typecheck clean; web production build
succeeds.

**Known flake baseline (unchanged by M5):** four real-clock trading-engine
suites (`adversarial`, `engine`, `rules.integration`, `determinism`) can fail
under full-parallel CPU contention and pass in isolation. M5’s engine changes
short-circuit when no controls are enabled and are additive; each of these suites
passes alone.

## Real browser acceptance

Two suites drive the real app against the real server and database:

- `tests/browser/portal-v2-acceptance.spec.mjs` — **45/45** — shell, theme toggle
  + persistence, switcher, all nav items, premium cards + nickname persistence,
  account-detail tabs, interactive performance, ten controls, payouts, and — end
  to end through the real HTTP API — locked tighten-only / no-loosen / no-disable,
  invalid-value rejection, IDOR denial, and the Atlas Trade→ handoff (select +
  strip). Screenshots: `v2-dashboard`, `v2-accounts`, `v2-account-overview`,
  `v2-performance`, `v2-controls`, `v2-payouts`.
- `tests/browser/portal-acceptance.spec.mjs` — **10/10** — updated for V2
  selectors; retains certificate-verification and profile-save coverage.

## Migrations

`0023_trader_risk_controls.sql` (journal index 23) applied and verified on both
`atlas` and `atlas_test`: three tables present, `orders.opened_exposure` present.

## Commits (branch `claude/futures-trading-simulator-v8qefu`)

```
3856ba8  docs: architecture + risk-control semantics (M5-A)
a123ad5  feat: personal risk-control domain, schema, API (M5-E)
f968351  feat: authoritative personal risk gate on the order path (M5-F)
0e025dc  test: copy-trading × personal risk-control isolation (M5-H)
e0aae0a  feat: Dashboard V2 — design system, command center, controls & payouts UI (M5-B/C/D/I/J)
7fea655  feat: consume portal Trade→ account handoff (M5)
3061522  feat: read-only trader personal risk controls in the owner console (M5-K)
9b34ca8  test: V2 portal + trader risk controls real-browser acceptance (M5-L)
```

## Related docs

- `happy-trader-dashboard-risk-controls-v1.md` — architecture + authoritative reuse map
- `trader-risk-controls-semantics.md` — locked semantics of all ten controls
- `happy-trader-design-system.md` — tokens, primitives, components
- `happy-trader-performance-analytics.md` — analytics sources and the drilldown
