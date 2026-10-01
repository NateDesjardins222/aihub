# Customer System Launch Gates

Go / no-go gates for taking the customer business system in front of paying
customers. A gate is GREEN only with a cited proof. "Internal" gates are
certifiable in this repository; "External" gates require the real providers and
are explicitly out of scope for this phase.

## Internal gates (certified here)

| Gate | Condition | Status | Evidence |
|------|-----------|--------|----------|
| LG-1 | One verified payment → exactly one account, under duplicates/concurrency/crash | GREEN | `commerce-chaos.test.ts`, INV-PUR-1 |
| LG-2 | No paid order silently lost (parks + sweep + detector) | GREEN | `INV_STRANDED_PURCHASE`, CPI report |
| LG-3 | 5-active cap holds under concurrency; portal reports the same constant | GREEN | `account-limit.test.ts`, `portal-lifecycle.test.ts` (§4D) |
| LG-4 | Cross-customer isolation at REST/order/portal/WS | GREEN | `golden-path.security.test.ts` |
| LG-5 | Portal→Atlas handoff never silently substitutes an account | GREEN | `account-selection.test.ts` (§4A) |
| LG-6 | Payout: single debit, 5-cycle cap, reversal crash-safe, ownership re-checked | GREEN | `payout-ops-torture.test.ts`, `payout-reversal-crash.test.ts` |
| LG-7 | Certificates/achievements exactly-once; clubs use PAID trader-share only | GREEN | `recognition.test.ts` |
| LG-8 | Support/affiliate connected to owner; affiliate apply deduped (both paths) | GREEN | `affiliate-lifecycle.test.ts` (§4C), support tests |
| LG-9 | Error ≠ zero everywhere customer money/state is shown | GREEN | `metric-display.test.ts` (§4B), `PortalApp.tsx` |
| LG-10 | Integrity detectors: no false positives, count every offender | GREEN | `customer-product-integrity.test.ts` (§7/§73) |
| LG-11 | `customer:certify` FAST+DEEP green, nonzero on failure, refuses prod | GREEN | `customer-certify.ts`; FAST run 8 suites/78 tests |
| LG-12 | Canonical release validation green (typecheck + full test + build) | see HARDENING_REPORT | `pnpm validate:release` |

## External gates (NOT certified here — must be done before real launch)

| Gate | Condition | Status | Owner |
|------|-----------|--------|-------|
| LG-X1 | Whop PRODUCTION webhooks signature-verified end to end | NOT VERIFIED | Nathan / ops |
| LG-X2 | Real payout rail connected, treasury funded, KYC gate live | NOT VERIFIED | Nathan / ops |
| LG-X3 | Rithmic live market data + execution acceptance | NOT VERIFIED | Nathan / ops |
| LG-X4 | Object storage for certificate artifacts; email/SMS delivery | NOT VERIFIED | Nathan / ops |
| LG-X5 | Human acceptance walkthrough of the golden customer journey | PENDING | Nathan |

All internal gates are GREEN. External gates are the launch work that this phase
deliberately did not touch (no production providers connected). See
`CUSTOMER_SYSTEM_CERTIFICATION.md` for the internal/external boundary.
