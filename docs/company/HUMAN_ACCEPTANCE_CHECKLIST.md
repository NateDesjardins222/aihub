# HUMAN ACCEPTANCE CHECKLIST

**Happy Trader Funding — the things only Nate (a human) can sign off.** Phase 12.5 (RC0).

> Automated tests and browser automation cannot approve the actual product experience. Nate must
> physically use each surface and mark **PASS / FAIL / NOT TESTED**. Claude must never mark these PASS.
> Until Nate completes the relevant sections, human acceptance is **BLOCKED — HUMAN**. Use safe/test
> provider paths only; **no real money, no production Rithmic, no real payouts.**

Mark each row: `[ ] PASS  [ ] FAIL  [ ] NOT TESTED` and add a note on any FAIL. This runbook is designed
to be completed in **one sitting** against a freshly-seeded local environment.

---

## 0. ONE-TIME STARTUP (do this first, once)

Everything below runs against the local dev database with deterministic seed fixtures. No external
provider, no real money.

```bash
# 1. From the repo root, prepare + seed the development database (Postgres 16 must be running).
pnpm --filter @atlas/server db:migrate
pnpm --filter @atlas/server db:seed

# 2. Start the API and the web app together.
pnpm dev
#    API  → http://localhost:4000   (health at /health, /ready, /version)
#    Web  → http://localhost:5173    (Vite dev server; the URL is printed on start)
```

**Deterministic seed credentials** (development only — the seed *refuses* to run in production):
- **Owner (SUPER_ADMIN):** `owner@atlasfutures.local` / `atlas-owner-2026`
- **Demo trader:** `demo@atlasfutures.local` / `atlas-demo-2026`
- The demo trader is provisioned with 3 accounts; all 10 commercial products are ACTIVE.

Health check before starting: open `http://localhost:4000/ready` → should be `200` with `db: ok`.

### Exact routes & logins (RC1 — read this before testing)

There is ONE web app (`http://localhost:5173` in dev) with distinct surfaces by URL, and ONE shared
sign-in door (sign in with the account whose surface you want; the login form no longer pre-fills anyone).

| Surface | URL | Sign in as | Notes |
|---|---|---|---|
| Public marketing site | `/` or `/home` (signed out) | — | The front door for visitors |
| **Customer login** | `/portal` (signed out shows the sign-in form) | trader | |
| **Customer Dashboard** | `/portal` (signed in) | `demo@atlasfutures.local` / `atlas-demo-2026` | Its overview panel is titled **"Command center"** — this is the CUSTOMER command center |
| Atlas trading terminal | `/` (signed in) or the portal's **Trade →** button | trader | Viewport-locked (chart app), intentionally does not page-scroll |
| **Owner login** | `/admin` (signed out shows the sign-in form) | owner | |
| **Owner OS / Owner Command Center** | `/admin` (Overview) and `/admin/command` (**Command Center**) | `owner@atlasfutures.local` / `atlas-owner-2026` | Branded **"ATLAS operations"**. This is the OWNER command center — a different route from the customer one |

**Atlas operations = the Owner OS.** The screen that said *"Atlas operations — this area is for operators.
Your account does not have access"* is the SAME operator console (`/admin`), shown when you are signed in as
a **trader**. It is not a separate app and not the wrong link — you were signed in as the demo trader. Sign
in as the owner (above) to enter it. That denial screen now names who you are signed in as and offers a
**"Sign out & switch account"** button.

**Two "Command center" headings, deliberately different pages:** the CUSTOMER one is the dashboard overview
at `/portal`; the OWNER one is the operator Command Center at `/admin/command`. Same words, different routes
and audiences — do not confuse them.

### Product Recovery Phase 1 changes (read before re-testing)

- **You no longer need to type `/admin`.** Signed in as the owner, an **Owner Console →** entry now appears
  in the portal profile menu (top-right avatar) **and** in the Atlas terminal's left rail ("Owner"). Click
  either to enter the Owner OS. A **trader never sees** this entry (verify: sign in as the demo trader — it
  is absent in both places).
- **The light/dark theme toggle is removed.** The portal is intentionally dark for now; a single fixed
  visual system comes with the later redesign. There is nothing to test here — just confirm no theme toggle
  is present.
- **Owner OS emergency controls are now operable from the console** (System → *Ops System*): each **kill
  switch** has an Engage/Release button (asks for a reason + your password step-up), and each **feature
  flag** has an Enable/Disable toggle. Engaging a kill switch raises a CRITICAL alert and is audited.
- **Trust test for a risk control (answers "does my max-loss actually work?"):** in the Portal open an
  account → Controls, set a **personal daily loss limit**, save, **refresh** (it persists), then in **Atlas**
  trade that account down to the limit — the next exposure-increasing order must be **rejected** with a
  reason naming the personal control (a reducing/closing order is still allowed). This is the definitive
  owner check; automated tests already prove the same on the engine's order path.

### Fastest end-to-end confidence check: the Human Golden Path

Before the exhaustive sections below, run **`HUMAN_GOLDEN_PATH.md`** (~23 checks): owner-console
discovery, the max-trades=1 rejection, an owner hold blocking Atlas, a kill switch, a bracket/OCO, and
cross-surface consistency. It is the shortest path to L5 (human-verified) for the trading-integrity
core. The behaviors it checks are already proven automatically to L3/L4 (see
`PRODUCT_BEHAVIORAL_TRUTH.md`); only your physical run assigns L5.

### First test on every page: can you scroll?

Before anything else, on BOTH the Customer Dashboard (`/portal`) and the Owner OS (`/admin`): the page has
more content than fits the screen — **scroll down with your mouse wheel** and confirm the lower content
(more account cards / lower panels) comes into view. If the page will not scroll, STOP and mark FAIL.

> **Production owner bootstrap (documented, do NOT run here):** production has no seeded owner. The
> first operator is created out of band with `ALLOW_OWNER_BOOTSTRAP=true BOOTSTRAP_OWNER_EMAIL=…
> BOOTSTRAP_OWNER_PASSWORD=… pnpm --filter @atlas/server owner:bootstrap`. It refuses if an owner
> already exists and never prints the password. Nate runs this once, on the real host, at go-live.

---

## A. PUBLIC SITE  (`http://localhost:5173/`)
- [ ] Home/landing loads; branding correct; no broken images.
- [ ] Products/pricing show all 10 with correct rules; no legacy product purchasable.
- [ ] Rule values match Portal/Atlas/Owner (no contradictions). *(Rule numeric facts are derived from one
      config — HTF-31 — so consistency %, split % and fees cannot drift between surfaces.)*
- [ ] Legal links present (Terms/Privacy/Refund/Risk) — even if draft.
- [ ] Support/contact path present.
- [ ] CTA/checkout entry works.
- [ ] **404:** visit `http://localhost:5173/this-page-does-not-exist` → a branded "404 — Page not found"
      with a Return-home link (NOT a blank page or a framework stack trace). *(HTF-30)*
- [ ] Mobile: usable at phone width.

## B. CHECKOUT
- [ ] Select a product → checkout surface renders correct product + price.
- [ ] Test/sandbox payment path completes; no browser-side provisioning.
- [ ] Account appears only after the server-verified event.
- [ ] Payment-failed and payment-pending states are understandable (no dead end).

## C. CUSTOMER PORTAL  (`/portal`, sign in as the demo trader)
- [ ] Register/login/logout.
- [ ] Dashboard + account cards + switcher.
- [ ] Evaluation progress; funded progress.
- [ ] Rules view matches the purchased product.
- [ ] Risk controls view + live state.
- [ ] Payouts: eligibility, request, status.
- [ ] Certificate vault.
- [ ] Billing/history (permanent).
- [ ] Support entry.
- [ ] Atlas hand-off (open the terminal for an account).
- [ ] Lifecycle: new → evaluation → failed → reset → passed → funded → payout eligible → requested →
      paid → completed all render with clear customer state.

## C2. MULTI-FACTOR AUTHENTICATION  (Portal → **Security**) — *new in 12.5*
- [ ] Security page shows "Two-factor authentication — not enabled" with an **Enable** button.
- [ ] **Enable** shows a manual-entry secret + otpauth URI; add it to an authenticator app.
- [ ] Entering the current 6-digit code activates MFA and shows **10 recovery codes once**.
- [ ] Sign out, then sign in with the same password → you are **challenged for a code** (no session yet).
- [ ] A wrong code is rejected; the correct code completes the login.
- [ ] Sign out; sign in; complete the challenge with **a recovery code** → it works exactly once.
- [ ] Back in Security, **Disable** requires the password AND a live code, then MFA is off.
- [ ] (Owner) Repeat C2 signed in as the owner — the owner account can enroll and be challenged.

## D. ATLAS (trading terminal) — physically trade each
- [ ] Login + account selector.
- [ ] Instruments load and price moves: **NQ, MNQ, ES, MES, GC, MGC, CL, MCL**.
- [ ] 1-minute chart + timeframe switching.
- [ ] Drawings/tools intended for launch behave.
- [ ] Order placement: market; limit (if supported); stop (if supported).
- [ ] Cancel order.
- [ ] Bracket creation; drag SL/TP; OCO.
- [ ] Position display + P&L correct.
- [ ] Risk display + lock behavior on breach.
- [ ] Account switching.
- [ ] Reconnect after network blip; browser refresh restores state.
- [ ] Layout/performance acceptable; no obvious visual launch-blockers.
- [ ] Mobile: **only** if Atlas mobile trading is intentionally supported (else mark N/A).

## E. OWNER OS — physically operate  (`/admin`, sign in as owner)
- [ ] Open `/admin`; **scroll the entire Command Center with a real mouse wheel** (the standing manual
      acceptance — Playwright is not sufficient).
- [ ] Command Center; Customers + Customer 360; account operations.
- [ ] Products/config; funding decisions; payouts + STP.
- [ ] Trading/risk surveillance; enforcement; support inbox.
- [ ] Affiliates; certificates; economics.
- [ ] Provider health; reconciliation center; audit explorer.
- [ ] Feature flags; kill switches (engage/release with reason); system health.
- [ ] **Inactivity sweep (HTF-18):** run the on-demand sweep (System → run, or
      `POST /api/v1/admin/ops/system/inactivity-sweep`) → returns `{closed, warned, at}` without error;
      running it twice in a row closes/warns nothing new (idempotent).
- [ ] Everything operable without SQL or Claude.

## F. SUPPORT
- [ ] Customer creates a ticket; owner/staff sees it with account context.
- [ ] Reply + resolve; remediation/refund workflow; escalation.

## G. CERTIFICATES
- [ ] A qualifying event issues the right certificate; vault + verification render; email intent fires.

## H. FAILURE STATES (no dead ends)
- [ ] payment failed / pending; KYC pending / failed; account failed; provider unavailable; market data
      stale; payout pending / rejected / unknown; support escalation; completed account — each shows a
      clear, non-technical explanation.
- [ ] **Unexpected UI error:** the app never shows a blank white page — a render error surfaces the
      branded "Something went wrong / Reload" boundary, with no stack trace shown to the customer. *(HTF-30)*

## I. SIGN-OFF
- [ ] Nate confirms overall UX is acceptable for the intended beta mode.
- Human acceptance is **BLOCKED — HUMAN** until the above are completed by Nate. Claude has not and will
  not self-certify any row here.

---

## RESULTS RECORD (fill in on completion)

| Section | PASS | FAIL | NOT TESTED | Notes |
|---|---|---|---|---|
| 0. Startup |  |  |  |  |
| A. Public site |  |  |  |  |
| B. Checkout |  |  |  |  |
| C. Portal |  |  |  |  |
| C2. MFA |  |  |  |  |
| D. Atlas |  |  |  |  |
| E. Owner OS (incl. scroll + inactivity) |  |  |  |  |
| F. Support |  |  |  |  |
| G. Certificates |  |  |  |  |
| H. Failure states (incl. error boundary) |  |  |  |  |
| I. Sign-off |  |  |  |  |

**Overall verdict (Nate):** ____ ACCEPTED for Mode ___ · ____ CHANGES REQUIRED (see FAIL notes)

Date: __________  Signed: __________
