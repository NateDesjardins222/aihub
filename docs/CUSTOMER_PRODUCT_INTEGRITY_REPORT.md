# Customer Product Integrity — Phase 1 Report

Governing question: *if a fresh customer signed up, bought a CORE 50K, traded, passed,
got funded, took a payout, contacted support, and received a certificate — would every
Happy Trader system show the SAME truthful customer, purchase, account, money, state
and history without manual DB surgery?* **Answer: yes.** The customer business system
is one connected, authoritative system. This phase verified it, fixed the one
customer-facing honesty gap found, hardened integrity detection, and fixed the EOD
canonical flake.

## Method

Five parallel read-only forensic traces (purchase→account, account↔Atlas, payout,
support+affiliate, dashboard/fixture/identity), each citing `file:line`, then
targeted fixes + tests. No speculative rewrites; REUSE-before-rebuild. Most of this
system was built and tested across milestones M1–M13; this phase proves connectivity
and closes gaps.

## Chain verdicts (all CONNECTED)

1. **Purchase → account** — CONNECTED, no P0/P1. Verified-payment-only (signature-verified
   webhook is the sole authority; browser success page is inert; no client "paid"
   field). Idempotent at four layers (provider-event id, order idem key, entitlement
   `(order,kind)`, provisioning key) — one verified payment → one account, proven
   under concurrency + crash recovery. 5-active cap enforced in one place
   (`account-limit.ts`, advisory-locked). Product/rule version pinned at acquisition.
   Stranded paid orders park in PROVISION_BLOCKED/FAILED with audit + events + sweep.
2. **Account ↔ Atlas** — CONNECTED, no P0/P1. One authoritative `accounts` row; Atlas
   reads it owner-scoped by `user_id` and never creates ownership. Portal "Trade"
   hands off the owned `publicId`; Atlas re-validates against the owner-scoped list;
   fallback is always to another OWNED account. Tradability gated server-side in
   `risk.ts checkOrder` (ACTIVE/GOAL_REACHED only). Cross-customer isolation enforced
   at REST read, order path, portal mutations, and WS subscriptions (all 404/deny).
   *P2/UX*: handoff silently falls back to another owned account if the linked
   publicId isn't visible; handoff resolver lacks a test (logged).
3. **Payout** — CONNECTED, no P0/P1. Ownership enforced + re-checked under lock;
   eligibility server-authoritative; customer request and owner queue are the SAME
   `payout_requests` row; single DEBIT at approve (unique ledger index); PAID →
   accounting → cycle → lifetime-paid → clubs → certificate is one coherent event
   chain; clubs use cumulative PAID trader-share only; 5th cycle completes the
   account and blocks a 6th.
4. **Support + Affiliate → Owner** — CONNECTED, no P1. Customer ticket → same row in
   owner inbox → operator reply → customer thread; IDOR-guarded; four-eyes on
   remediation. Affiliate application → `affiliate_applications` → owner
   ApplicationsPanel (approve/decline/request-info). *P3*: anonymous affiliate apply
   has no dedup (rate-limited only).
5. **Dashboard / fixtures / identity** — CLEAN, no P1. Production serves V1 (real API
   only); V2 + all fixtures are dev-gated (404 in prod); a guardrail test blocks
   fixture imports into production. No `NATETRADEZ` anywhere; CORE 150K is retired
   (`LEGACY_RETIRED_KEYS`), never purchasable; dev seeds prod-blocked. Certificate
   name is server-derived from `customer_identities`. Fresh customer = truthful zeros.
   *Defect found & FIXED*: top-level accounts fetch collapsed API errors into an empty
   "new customer" view (error≠zero) — now shows an error+retry banner.

## Changes made this phase

- **error≠zero fix** (`PortalApp.tsx`): accounts-fetch failure no longer renders a
  fake empty authoritative view; it flags an error and shows a retry banner.
- **Integrity detectors** (`integrity.ts`): added `INV_STRANDED_PURCHASE`,
  `INV_ORPHAN_ACCOUNT`, `INV_OWNERSHIP_MISMATCH`, wired into `runIntegrityChecks`;
  proven by `customer-product-integrity.test.ts` (clean seed PASS; each detector
  FAILs on injected bad data).
- **EOD canonical flake** (`eod-trailing-engine.test.ts`): root cause was a fixed
  `settle(20)` sleep that is insufficient under full-suite contention (test-only
  timing dependency, NOT a risk-engine defect — engine semantics unchanged). Fixed by
  awaiting the order's observable terminal state instead of sleeping; deterministic
  across repeated runs. Portal/Atlas consistency is structural (one `accounts` table),
  so it is asserted by the account-ownership tests rather than a DB drift check.

## Defect ledger

| ID | Sev | Finding | Status |
|---|---|---|---|
| CPI-1 | P2/UX | Portal→Atlas handoff falls back to another owned account if linked publicId not visible; resolver untested | Documented (hardening-phase candidate) |
| CPI-2 | P2 | Dashboard payout-count badge degrades to 0 on fetch error | Documented |
| CPI-3 | P3 | Anonymous affiliate `/apply` has no duplicate/email dedup (rate-limited) | Documented |
| CPI-4 | note | `portal-accounts.ts` duplicates the literal `5` instead of importing `MAX_ACTIVE_ACCOUNTS` (display-only) | Documented |

**P0: none. P1: none.**

## Hard question answers (§123)

153 fresh customer zero fake accounts — **YES** · 154 unpaid creates account — **NO** ·
155 success URL creates account — **NO** · 156 one verified purchase → one account —
**YES** · 157 tied to durable identity — **YES** · 158 account in Portal — **YES** ·
159 account in Atlas (same record) — **YES** · 160 Billing shows purchase — **YES** ·
161 Owner locates purchase/account/customer — **YES** · 162 Dashboard derives from
authoritative state — **YES** · 163 Portal shows account Atlas denies — **NO** ·
164 Atlas exposes unjustified account — **NO** · 165 eval pass → one funded — **YES** ·
166 funded lineage preserved — **YES** · 167 payout tied to correct account/customer —
**YES** · 168 customer payout state == owner — **YES** · 169 PAID updates accounting —
**YES** · 170 PAID updates Progress lifetime — **YES** · 171 unpaid leaves clubs
unchanged — **YES** · 172 paid payout → payout certificate — **YES** · 173 customer can
preview/download cert — **YES** · 174 cert name from authoritative identity — **YES** ·
175 support ticket in Owner OS — **YES** · 176 owner reply ↔ customer thread — **YES** ·
177 affiliate application in Owner OS queue — **YES** · 178 Nathan operates without SQL
— **YES** (launch-critical) · 179 email change preserves ownership — **YES** (identity
is the key, not email) · 180 production route imports review/demo data — **NO** ·
181 server restart preserves truth — **YES** · 182 failure distinguishable from zero —
**YES** (fixed on the primary accounts fetch; CPI-2 secondary badge noted) ·
183 paid purchase silently loses account — **NO** · 184 unresolved P0 — **NO** ·
185 unresolved P1 — **NO**.

## EOD flake (§121)

137 reproduction — passes in isolation, fails only under full-suite load · 138 root
cause — fixed `settle(20)` sleep vs. async fill pipeline under contention · 139
production risk — **NO** · 140 test-only risk — **YES** · 141 fix — await observable
terminal order state · 142 proof — 3/3 deterministic isolated runs + canonical.

## Human acceptance

Automated + cross-system verified. **Human acceptance remains pending — Nathan
decides.** Not claimed as human-approved.
