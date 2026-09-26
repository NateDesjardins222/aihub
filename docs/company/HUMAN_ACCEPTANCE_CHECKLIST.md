# HUMAN ACCEPTANCE CHECKLIST

**Happy Trader Funding — the things only Nate (a human) can sign off.** Phase 12 (2026-09-26).

> Automated tests and browser automation cannot approve the actual product experience. Nate must
> physically use each surface and mark **PASS / FAIL / NOT TESTED**. Claude must never mark these PASS.
> Until Nate completes the relevant sections, human acceptance is **BLOCKED — HUMAN**. Use safe/test
> provider paths only; no real money.

Mark each row: `[ ] PASS  [ ] FAIL  [ ] NOT TESTED` and add a note on any FAIL.

## A. PUBLIC SITE
- [ ] Home/landing loads; branding correct; no broken images.
- [ ] Products/pricing show all 10 with correct rules; no legacy product purchasable.
- [ ] Rule values match Portal/Atlas/Owner (no contradictions).
- [ ] Legal links present (Terms/Privacy/Refund/Risk) — even if draft.
- [ ] Support/contact path present.
- [ ] CTA/checkout entry works.
- [ ] No broken links; 404 shows a real page (not a framework error).
- [ ] Mobile: usable at phone width.

## B. CHECKOUT
- [ ] Select a product → checkout surface renders correct product + price.
- [ ] Test/sandbox payment path completes; no browser-side provisioning.
- [ ] Account appears only after the server-verified event.
- [ ] Payment-failed and payment-pending states are understandable (no dead end).

## C. CUSTOMER PORTAL
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
- [ ] Mobile: **only** if Atlas mobile trading is intentionally supported (else mark N/A and ensure the
      product does not imply it).

## E. OWNER OS — physically operate
- [ ] Open `/admin`; **scroll the entire Command Center with a real mouse wheel** (the standing manual
      acceptance — Playwright is not sufficient).
- [ ] Command Center; Customers + Customer 360; account operations.
- [ ] Products/config; funding decisions; payouts + STP.
- [ ] Trading/risk surveillance; enforcement; support inbox.
- [ ] Affiliates; certificates; economics.
- [ ] Provider health; reconciliation center; audit explorer.
- [ ] Feature flags; kill switches (engage/release with reason); system health.
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

## I. SIGN-OFF
- [ ] Nate confirms overall UX is acceptable for the intended beta mode.
- Human acceptance is **BLOCKED — HUMAN** until the above are completed by Nate. Claude has not and will
  not self-certify any row here.
