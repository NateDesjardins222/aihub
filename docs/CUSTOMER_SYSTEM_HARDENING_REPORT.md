# Customer System Hardening & Adversarial Certification — Phase 1 Report

Governing goal: break the customer business system before customers can — prove
every customer chain correct under duplicates, concurrency, crashes, stale
clients, IDOR and malformed payloads — then certify it. Baseline commit `635447a`
(end of Customer Product Integrity). This phase added NO product breadth: only the
smallest correct fixes to repair demonstrated defects, their regressions, the
certification harness, and the documentation that ties proofs to invariants.

## What changed (smallest correct fixes only)

The four CPI carry-forwards, each root-caused and fixed with a deterministic
regression:

- **§4A — Portal→Atlas handoff (CPI-1, P2→fixed).** Root cause: `refreshAccounts`
  fell through from an unresolvable explicit handoff to remembered→practice→first,
  presenting a different account as though the handoff had succeeded. Fix: the
  selection decision is now a pure function `resolveAccountSelection`
  (`apps/web/src/state/account-selection.ts`) — a verified handoff selects exactly
  the requested account; an unresolvable one sets `handoffUnavailable` and the
  terminal shows a notice (`HandoffNotice.tsx`); only a resolved handoff is
  persisted. **8 regression cases** (`account-selection.test.ts`). The resolver,
  which previously had NO coverage, is now exhaustively tested.
- **§4B — error ≠ zero (CPI-2).** Root cause: a failed `/certificates` fetch set
  the dashboard payout count to `0`. Fix: `countBadge()`
  (`apps/web/src/portal/metric-display.ts`) returns "—" on error, distinct from a
  real "0". **5 regression cases**.
- **§4C — affiliate anonymous dedup (CPI-3).** Root cause: only the logged-in apply
  path deduped. Fix: `submitApplication` dedups the anonymous path by email (and
  the logged-in path by id OR email), DECLINED may re-apply. **3 regression cases**.
- **§4D — single-source cap (CPI-4).** `portal-accounts.ts` now imports
  `MAX_ACTIVE_ACCOUNTS` instead of a re-typed `5`; the portal regression asserts
  the reported cap equals the enforcement constant.

Detector hardening (§7/§73): the three customer-provenance detectors gained
**5 new cases** proving no false positives (legitimate-but-unusual rows stay PASS)
and multi-corruption counting (every offender counted; all families surface in one
run) — `customer-product-integrity.test.ts` now 9 cases.

New certification harness (§105/§106): `pnpm customer:certify`
(`apps/server/scripts/customer-certify.ts`) — FAST + `CUSTOMER_CERTIFY_DEEP=1`,
`--json`, nonzero exit on failure, refuses to target production (exit 3), and
separates INTERNAL SOFTWARE CERTIFIED from EXTERNAL PRODUCTION UNVERIFIED.

No trading economics changed. No production providers connected. No visual polish,
no mass refactor.

## Required numbers (§115)

- Invariant families in the ledger: **15** (IDENTITY, OWNERSHIP, PURCHASE, ACCOUNT,
  ATLAS, TRADE/RISK, LIFECYCLE, PAYOUT, CERT/PROGRESS, SUPPORT/AFFILIATE, HONESTY,
  AUDIT, RECON — see `CUSTOMER_SYSTEM_INVARIANT_LEDGER.md`).
- Attack families in the adversarial matrix: **27**.
- Chaos scenarios: **13**.
- Carry-forward defects fixed: **4** (CPI-1..4), all with regressions.
- New/added regression cases this phase: **4A:8, 4B:5, 4C:3, 4D:1, detectors:5** =
  **22** new customer-chain assertions, plus the detector suite now at 9 cases.
- `customer:certify` FAST: **8 proof suites / 78 tests**, integrity PASS, exit 0.
- P0 open: **0** · P1 open: **0** · P2 open: **0** · residual accepted: **1**
  (HARD-1, query-guard dedup race, rate-limit-mitigated, not launch-blocking).
- Canonical release validation: see "Validation" below.

## Validation (§110)

Run once at the end, not blindly repeated:

- Web typecheck: PASS. Server typecheck: PASS.
- `pnpm customer:certify` FAST: PASS (8 suites / 78 tests, integrity clean, exit 0).
- Production guard: refuses with `NODE_ENV=production` / prod DATABASE_URL (exit 3).
- Canonical `pnpm validate:release` (prepare-test-db + typecheck + full test +
  build): **<RESULT PENDING — patched on completion>**.

## Defect ledger

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| CPI-1 | P2/UX | Handoff silently substituted another account | FIXED (§4A) + 8 tests |
| CPI-2 | P2 | Dashboard payout badge error-as-zero | FIXED (§4B) + 5 tests |
| CPI-3 | P3 | Anonymous affiliate apply had no dedup | FIXED (§4C) + 3 tests |
| CPI-4 | note | Duplicated active-cap literal | FIXED (§4D) + regression |
| HARD-1 | note | dedup is a query-guard, not a unique index (sub-second race) | Accepted; rate-limited; future partial index |

**P0: none. P1: none. P2: none open.**

## The 41 hard questions (§118)

Answered YES/NO with evidence. "YES" = the safe behaviour holds and is proven.

1. Can a duplicate verified payment create two accounts? **NO** — `commerce-chaos.test.ts`.
2. Can concurrent fulfillment of one order create two entitlements? **NO** — idem keys, `commerce-chaos`.
3. Can a crash mid-provision strand money invisibly? **NO** — parks + sweep + `INV_STRANDED_PURCHASE`.
4. Can the browser success page create an account? **NO** — inert; webhook is sole authority.
5. Can an unsigned/forged webhook complete an order? **NO** — `verifyStandardWebhook`.
6. Can a customer exceed 5 active accounts under concurrency? **NO** — advisory lock, `account-limit.test.ts`.
7. Does the portal ever show a cap different from enforcement? **NO** — single `MAX_ACTIVE_ACCOUNTS` (§4D).
8. Can one customer read another's account over REST? **NO** — owner-scoped, `golden-path.security`.
9. Can one customer follow another's account over WS? **NO** — `mayFollowAccount`.
10. Can a Portal handoff open an account the customer doesn't own? **NO** — matched against owner list (§4A).
11. Does an unresolvable handoff silently open a different account? **NO** — surfaced via `handoffUnavailable` (§4A).
12. Is the handoff resolver tested? **YES** — 8 cases, previously none.
13. Can a malformed `?account=` crash or inject? **NO** — shape-sanitised, rejected.
14. Can a LOCKED/FAILED account place an order? **NO** — `risk.ts checkOrder`.
15. Is any customer money a float? **NO** — integer micro-dollars end to end.
16. Can the UI render `$NaN` / `-0`? **NO** — formatter guards.
17. Can a payout be debited twice? **NO** — unique ledger index, `payout-ops-torture`.
18. Can a payout reversal crash strand a debit? **NO** — `payout-reversal-crash.test.ts`.
19. Can a 6th payout cycle run? **NO** — 5th completes the account.
20. Can a customer request another customer's payout? **NO** — ownership re-checked under lock.
21. Is the customer's payout state the same row the owner sees? **YES** — one `payout_requests` row.
22. Can a certificate be issued twice for one event? **NO** — `(org,dedupeKey)`, `recognition.test.ts`.
23. Can an achievement unlock twice on replay? **NO** — same.
24. Do clubs/lifetime count anything but PAID trader-share? **NO** — PAID-only.
25. Can a tracked goal be forged? **NO** — `personal-goals.test.ts`.
26. Is the certificate name ever fixture text? **NO** — derived from identity.
27. Can a failed fetch render as an authoritative zero? **NO** — "—" on error (§4B).
28. Can a failed accounts fetch render as a fake empty vault? **NO** — error+retry banner.
29. Is a real zero distinguishable from an error? **YES** — "0" vs "—" (§4B tests).
30. Does a support ticket reach the owner inbox as the same row? **YES**.
31. Is support IDOR-guarded with four-eyes remediation? **YES** — `INV_REMEDIATION_FOUR_EYES`.
32. Can an anonymous affiliate apply create duplicates? **NO** — email dedup (§4C).
33. Can a logged-in affiliate apply create duplicates? **NO** — id/email guard.
34. Can a DECLINED applicant re-apply? **YES** — intended.
35. Do the integrity detectors false-alarm on legitimate data? **NO** — §7/§73 cases.
36. Do they count every offender, not just the first? **YES** — multi-corruption case.
37. Do all corruption families surface together in one run? **YES** — one-run case.
38. Does a server restart lose any customer truth? **NO** — reconstructed from DB.
39. Can production import review/demo fixtures? **NO** — dev-gated + guardrail test.
40. Does `customer:certify` exit nonzero on failure and refuse production? **YES** — exit 2/3.
41. Is any external production provider claimed as verified? **NO** — explicitly UNVERIFIED.

## Human acceptance

Automated, cross-system software certification. **Human acceptance remains pending
— Nathan decides.** No external production provider is verified; nothing here is
claimed as production-ready or human-approved.
