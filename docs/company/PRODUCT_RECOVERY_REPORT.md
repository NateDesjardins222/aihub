# PRODUCT RECOVERY — PHASE 1 REPORT

**Happy Trader Funding.** Functional-truth, connectivity & operability audit + minimal repair of
inaccessible/broken connectivity. From RC1 `dac5fd1`, branch
`claude/futures-trading-simulator-v8qefu`. Software-only: no real money, no production providers,
no Phase 13, no visual redesign. Companion docs: `PRODUCT_FUNCTIONAL_TRUTH.md`,
`PRODUCT_UX_DEBT.md`, `KNOWN_ISSUES.md` (Phase-1 section), `HUMAN_ACCEPTANCE_CHECKLIST.md`.

Method: three source-tracing passes (Portal, Atlas, Owner OS) following every actionable control
from handler → API → route → domain → DB → downstream/audit; then minimal repair of the
critical inaccessible controls; then real-Chromium proof and canonical validation.

---

## The 25 questions

**1. How many meaningful customer controls exist?** 61 traced in the Customer Portal (plus 33 in
Atlas the customer also uses).

**2. How many are E2E VERIFIED?** Portal 56 / 61; Atlas 33 / 33 (dev). The risk-control chain is
E2E-verified and enforced.

**3. How many are PARTIAL?** Portal 2 (framed-cert prod order; billing-history view). Atlas 0.

**4. How many are BROKEN?** 0 (Portal, Atlas, Owner OS — no rendered control is broken).

**5. How many are UI-ONLY / fake?** 0. No `alert()`/no-op/empty-onClick/dead-href control found
on any surface. No dishonest/hardcoded metrics.

**6. How many are BACKEND-ONLY / unreachable?** Portal 1 (per-achievement visibility). Owner OS
12 families (the real gap — real routes, no console UI). Atlas 0 (2 gated live seams, by design).

**7. Which Portal controls were repaired?** The customer theme toggle was **removed** (owner
request; portal pinned to dark). No Portal control needed connectivity repair — the portal was
already E2E-wired.

**8. Which Portal controls remain untrusted?** Framed-certificate order in production (P2, behind
disabled `MERCH_ENABLED`; shows success while the order stays pending — belongs to the commerce
phase). Billing-history is an informational gap (P3). Neither is money/security/risk.

**9. Do trader risk controls actually enforce in Atlas?** **Yes.** The value a customer saves is
written to `traderRiskControls`; the Atlas order path reads the **same** table
(`loadPersonalConfig`) and enforces it (`evaluatePersonalRisk` → `OrderRejectedError`),
additive/tighten-only, never blocking a reduce/flatten/liquidation.

**10. Which risk controls were proven individually?** All ten, on the real order path, by
deterministic engine-integration tests `personal-risk-gate.test.ts` G01–G10:
DAILY_LOSS_LIMIT (G07), MAX_POSITION (G03), MAX_TRADES (G02), DAILY_CONTRACT_LIMIT (G04),
CONSECUTIVE_LOSS_LOCK + COOLDOWN (G06), PROFIT_LOCK, DAILY_DRAWDOWN, TRADING_WINDOW,
SESSION_RESTRICTION (evaluator + gate), plus never-block-liquidation (G09) and
persist-across-restart (G10). Save/lock covered by `personal-risk.crud.test.ts`.

**11. Which failed?** None.

**12. Can owner naturally discover Owner Console?** **Yes (repaired).** A role-gated
`Owner Console →` now appears in the portal profile menu **and** the terminal app rail. Proven in
browser (owner sees it in both; clicking reaches the allowed Owner OS).

**13. Can trader see Owner Console? (must be NO)** **NO.** Proven in browser: the entry is absent
for a trader in both the portal profile menu and the terminal rail; a trader who types `/admin`
still hits the honest denial screen.

**14. Can owner enter Owner OS without knowing `/admin`?** **Yes** — via the discoverable entry
points above. No secret URL, no manual typing required.

**15. Which Owner OS mutations are actually proven?** ~24 mutating families are E2E-wired
(account lifecycle, customer ops, funding, payouts + payout ops, enforcement, products,
affiliates, support, cert store). Repaired-and-proven this phase: **kill-switch engage/release**
(with `KILL_SWITCH` step-up) and **feature-flag toggle** — both round-tripped in browser
(engage → ENGAGED → release → released; flag Enable → Disable), server routes/permissions/audit
unchanged.

**16. Which Atlas functions are correct?** Market data (real delayed OHLCV), simulated execution
via the ExecutionProvider abstraction (single-tx DB writes), firm + personal risk enforcement,
brackets/OCO/drag-modify, positions/P&L, all 8 instruments, WS reconnect/resume, copy trading.

**17. Which Atlas functions are functionally correct but UX-unacceptable?** The terminal as a
whole (owner-rejected feel/lag/tool/presentation quality). Functionally correct; quality tracked
as UX debt for a later phase.

**18. Which Atlas functions are broken?** None. (Live external feed/execution are deliberately
gated seams, off in dev.)

**19. Are Portal / Atlas / Owner OS authoritative values consistent?** Yes by construction: all
three read the server as the single source (accounts, balance, P&L, MLL, personal risk, payout,
enforcement, certificate state). The risk value written in the Portal is the exact value the
Atlas engine reads and Owner OS inspects. Presentation may format/round; underlying values agree.
Full one-customer cross-surface truth-table remains a human acceptance step (needs live trading).

**20. Any P0?** **None.** No money corruption, no security/RBAC bypass, no cross-customer leak,
no risk bypass, no wrong-account execution, no double payout, no identity/state corruption.

**21. Any P1?** Three, all "Owner-OS functionality inaccessible" (route exists, no UI): kill
switches and feature flags — **both repaired this phase**; **staff management** (invite / role /
suspend / revoke sessions) — documented, deferred to Phase 2 (needs a dialog, i.e. a build, not
a wiring fix).

**22. Which backend systems are clearly worth preserving?** Authoritative product config;
lifecycle/state machines; risk engine + personal-risk gate; payout logic + ledger; execution &
market-data provider abstractions; identity/RBAC + step-up reauth + MFA; enforcement/holds +
hash-chained audit; support, certificates, affiliates, economics; account projections +
reconciliation. All genuinely E2E and correct — do NOT rewrite.

**23. Which frontend surfaces should later be rebuilt?** Customer Portal presentation
(owner-rejected quality); Atlas interaction/feel/perceived performance; Owner OS presentation
(secondary, review after natural access). See `PRODUCT_UX_DEBT.md`.

**24. Which dead/duplicate surfaces were found?** Very few. Removed: the customer theme toggle +
its dead `theme.ts`. Corrected: a StaffPage note that referenced a non-existent "invite dialog".
Two "Command center" headings (customer `/portal` vs owner `/admin/command`) are deliberately
different pages — documented, not renamed. No duplicate/orphan mutating controls or fake metrics
found.

**25. What should Product Recovery Phase 2 be?** Owner's decision. Recommended, in order:
(a) **Owner OS operability completion** — build the staff-management console UI and surface the
remaining BACKEND-ONLY families (inactivity-sweep, alert ack/resolve, incident CRUD,
impersonation, owner-account adjust/pause) using the same step-up pattern; (b) **Customer trust &
legibility** — make risk-control enforcement visible (active/enforced state, live headroom,
rejection reason surfaced in Atlas) without a full redesign; (c) then the **Portal/Atlas visual
rebuild** as its own dedicated phase (per `PRODUCT_UX_DEBT.md`). The framed-cert prod fake-success
(P2) is handled by the commerce phase, not here.

---

## What was changed (files)
- `apps/web/src/lib/roles.ts` (new) — `canAccessOwnerConsole`/`resolveRole`, mirroring the
  server/AdminApp gate exactly (UI affordance only; server RBAC unchanged).
- `apps/web/src/portal/PortalApp.tsx` — removed theme toggle + hook; role-gated
  `Owner Console →` in the profile menu.
- `apps/web/src/components/AppRail.tsx` + `AppRail.css` — role-gated `Owner` entry in the
  terminal rail; anchor text-decoration reset.
- `apps/web/src/portal/theme.ts` — **deleted** (only the removed toggle used it).
- `apps/web/src/admin/lib/stepup.ts` (new) — shared operator step-up helper (mint + `x-stepup-token`).
- `apps/web/src/admin/pages/OwnerOsPages.tsx` — feature-flag toggle + kill-switch engage/release
  (inline step-up), gated by `mayMutate`; honest staff note.
- `apps/web/src/admin/pages/../AdminApp.tsx` — pass `mayMutate` to the System page.
- `apps/web/src/admin/Admin.css` — `.adm-inline-form` style.
- Docs: `PRODUCT_FUNCTIONAL_TRUTH.md`, `PRODUCT_UX_DEBT.md`, this report;
  `HUMAN_ACCEPTANCE_CHECKLIST.md` + `KNOWN_ISSUES.md` updated.

No server route, domain service, schema, migration, or RBAC rule was changed. No backend rewrite.

## Validation
- Typecheck: all 5 projects clean. Web build clean.
- Browser proof (real Chromium): **11/11 PASS** — theme toggle removed (owner+trader); Owner
  Console entry present for owner and absent for trader in **both** portal and terminal;
  owner-console link reaches the allowed Owner OS; kill-switch engage+release via step-up;
  feature-flag toggle; trader still denied at `/admin`.
- Automated risk-enforcement evidence: `personal-risk-gate.test.ts` G01–G10 (+ evaluator/CRUD).
- Canonical (one run, clean seed): **202 test files, 2922 tests — ALL PASS (exit 0)**, 407s. No
  regressions; no nondeterminism, so no ×2 re-run was needed.

## Testing philosophy (STEP 17)
Automated tests are supporting evidence, not the acceptance authority. For each repaired path this
report records AUTOMATED evidence (tests) + REAL BROWSER evidence (11/11) and marks where HUMAN
acceptance is still required (the live "set a limit → trade → get rejected in Atlas" flow; the
one-customer cross-surface truth table; overall UX quality). No low-value tests were added; the
new UI wiring is proven in-browser and its server routes already have `owner-config-http.test.ts`.

## Hard-stop conditions (STEP)
None triggered. No money corruption, cross-customer access, trader→owner escalation, risk bypass,
wrong-account execution, irreconcilable balances, double-payout path, identity collision, or
destructive migration was found.

## Checkpoint
Local tag `product-recovery-1-start` marks the pre-work point (`dac5fd1`). This phase's work is
recorded by the branch commit (see git log). **Human acceptance is NOT self-certified** — the
owner reviews next. Product Recovery Phase 2 does not begin automatically.
