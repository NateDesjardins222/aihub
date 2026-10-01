# Customer System Adversarial Matrix

Each attack family, the invariant it targets, the concrete attack, the expected
safe outcome, and the proof that enforces it. Workflow was ATTACK → REPRODUCE →
TRACE → FIX ROOT CAUSE → REGRESSION → ATTACK AGAIN. This phase REUSES the existing
adversarial suites and adds only the gaps the four carry-forwards and the detector
hardening required. "Proof" names the vitest suite whose failure would mean the
attack succeeds.

| # | Family | Attack | Expected safe outcome | Proof |
|---|--------|--------|------------------------|-------|
| A1 | Duplicate payment | Same verified webhook delivered N× / replayed | One account; later deliveries no-op | `commerce-chaos.test.ts` |
| A2 | Concurrent fulfillment | N concurrent completions of one order | One entitlement, one account (idem keys) | `commerce-chaos.test.ts` |
| A3 | Crash mid-provision | Kill between order-complete and account create | Order parks BLOCKED/FAILED; sweep recovers; no double account | `commerce-chaos.test.ts`, `INV_STRANDED_PURCHASE` |
| A4 | Forged "paid" | Hit success page / POST without a verified webhook | No order completion, no account | whop webhook tests (`verifyStandardWebhook`) |
| A5 | Cap bypass | Open a 6th active account concurrently | Advisory lock refuses; cap holds at 5 | `account-limit.test.ts` |
| A6 | Cap display drift | Portal shows a cap different from enforcement | Portal reports `MAX_ACTIVE_ACCOUNTS` (single source) | `portal-lifecycle.test.ts` (§4D) |
| A7 | IDOR — REST read | Read another owner's account via `/api/v1/accounts` | 404/deny (owner-scoped) | `golden-path.security.test.ts` |
| A8 | IDOR — WS follow | Subscribe to another owner's account stream | `mayFollowAccount` denies | `golden-path.security.test.ts` |
| A9 | Handoff substitution | Portal hands off account A that is not visible | Atlas surfaces "unavailable"; never selects B as A | `account-selection.test.ts` (§4A) |
| A10 | Stale client handoff | `?account=` points at a now-locked/failed account | Fallback is flagged, not passed off as the request | `account-selection.test.ts` (§4A) |
| A11 | Malformed handoff | `?account=` with junk / overlong / symbols | Shape-sanitised and rejected, no crash | `account-selection.test.ts`, `session.ts readAccountHandoff` |
| A12 | Trade a dead account | Order on LOCKED/FAILED/PASSED account | `risk.ts checkOrder` rejects (ACTIVE/GOAL_REACHED only) | risk/golden-path tests |
| A13 | Double debit | Approve a payout twice / concurrently | One DEBIT (unique ledger index) | `payout-ops-torture.test.ts`, `INV_NO_DOUBLE_DEBIT` |
| A14 | Payout reversal crash | Crash during fail/reversal of a payout | Ledger reconciles; no stranded debit | `payout-reversal-crash.test.ts`, `INV_FAILED_PAYOUT_DEBIT_REVERSED` |
| A15 | 6th cycle | Request a payout after the 5th completes | Blocked; account completed | `payout-ops-torture.test.ts`, `INV_PAYOUT_CYCLES` |
| A16 | Payout IDOR | Request/inspect another owner's payout | Ownership re-checked under lock; deny | `payout-ops-torture.test.ts` |
| A17 | Duplicate certificate | Replay the lifecycle events behind a cert | Exactly one cert/achievement `(org,dedupeKey)` | `recognition.test.ts` |
| A18 | Forged progress | Fabricate a tracked-goal completion | Progress derives from PAID state; cannot forge | `personal-goals.test.ts` |
| A19 | Support IDOR | Read/reply to another customer's ticket | Deny; four-eyes on remediation | support tests, `INV_REMEDIATION_FOUR_EYES` |
| A20 | Duplicate affiliate apply (anon) | Submit the same email twice | Second refused (ALREADY_APPLIED); one row | `affiliate-lifecycle.test.ts` (§4C) |
| A21 | Duplicate affiliate apply (auth) | Logged-in user applies twice | Refused unless prior was DECLINED | `affiliate-lifecycle.test.ts` |
| A22 | Error-as-zero | `/certificates` fetch fails on dashboard | Badge shows "—", never a false "0" | `metric-display.test.ts` (§4B) |
| A23 | Error-as-empty | Accounts fetch fails | Error+retry banner, not a fake empty vault | `PortalApp.tsx` (`pt-accounts-error`), CPI |
| A24 | Detector false alarm | Legitimate-but-unusual rows present | Detectors stay PASS (no cry-wolf) | `customer-product-integrity.test.ts` (§7/§73) |
| A25 | Multi-corruption | Several bad rows / all families at once | Each counted; all families reported in one run | `customer-product-integrity.test.ts` (§73) |
| A26 | Fixture leak | Production route imports review/demo data | Dev-gated (404 in prod); guardrail test blocks imports | existing fixture guardrail test |
| A27 | Restart truth | Server restart | All truth from the DB; nothing in memory | `commerce-chaos`/resilience suites |

See `CUSTOMER_SYSTEM_CHAOS_SCENARIOS.md` for the end-to-end chaos runs and
`CUSTOMER_SYSTEM_INVARIANT_LEDGER.md` for the invariant each attack targets.
