# Customer System Chaos Scenarios

End-to-end chaos runs exercised against the customer business chains, and where
each is proven. These are the "what if everything happens at once / at the worst
moment" scenarios; per-invariant attacks are in `CUSTOMER_SYSTEM_ADVERSARIAL_MATRIX.md`.

| ID | Scenario | Chaos injected | Expected steady state | Proof |
|----|----------|----------------|-----------------------|-------|
| C1 | Payment storm | One verified purchase, webhook delivered 10× concurrently + replayed after a crash | Exactly one entitlement + one account; every extra delivery a no-op | `commerce-chaos.test.ts` |
| C2 | Provision crash loop | Kill the process between order-complete and account-create, repeatedly | Order parks PROVISION_BLOCKED/FAILED; sweep provisions once on recovery; `INV_STRANDED_PURCHASE` flags any left behind | `commerce-chaos.test.ts`, `customer-product-integrity.test.ts` |
| C3 | Cap race | 8 concurrent "open account" requests for an owner at 4 active | Exactly one reaches 5; the rest refused by the advisory lock | `account-limit.test.ts` |
| C4 | Stale terminal | Trader leaves Atlas open; the handed-off account is locked/failed server-side; they reload via the old `?account=` link | Terminal shows the handoff-unavailable notice and a fallback OWNED account, never the dead account as if live | `account-selection.test.ts` |
| C5 | Payout double-tap | Operator approves a payout twice / two operators approve concurrently | One DEBIT; ledger unique index rejects the second | `payout-ops-torture.test.ts` |
| C6 | Reversal crash | Crash during a payout fail/reversal | On recovery the ledger reconciles; no stranded debit, no double reversal | `payout-reversal-crash.test.ts` |
| C7 | Cycle exhaustion | Drive an account through all 5 payout cycles, then attempt a 6th | 5th completes the account; 6th blocked | `payout-ops-torture.test.ts` |
| C8 | Event replay | Replay evaluation.qualified / account.funded / payout.paid / account.completed | Certs/achievements/clubs each move exactly once | `recognition.test.ts` |
| C9 | Subscriber failure | A deferred recognition subscriber throws | Originating transaction already committed; read-time reconcile heals; no corruption | `recognition.test.ts`, progress reconcile |
| C10 | Connectivity loss | Portal API calls fail (network down) | Error+retry banners and "—" unknowns, never fake zeros or fake empties | `metric-display.test.ts`, `PortalApp.tsx` |
| C11 | Malformed input | Junk `?account=`, oversized payloads, bad content-type | Shape-sanitised / rejected with a clean error; no crash, no state change | `account-selection.test.ts`, security suites |
| C12 | Multi-family corruption | Several provenance corruptions injected at once | Every detector FAILs independently in one integrity run; counts are exact | `customer-product-integrity.test.ts` |
| C13 | Restart | Hard restart of the server mid-flow | All customer truth reconstructed from the DB; nothing authoritative lived in memory | commerce-chaos + resilience suites |

Run the aggregate proof with `pnpm customer:certify` (FAST) or
`CUSTOMER_CERTIFY_DEEP=1 pnpm customer:certify` (adds C1/C3/C5/C6 torture tiers).

## Not simulated here (out of scope / external)

Real provider outages (Rithmic, Whop-production, payout rail, KYC, email) are NOT
chaos-tested in this environment because those providers are NOT connected. Their
fail-closed seams are proven (`providerSafetySummary`, UNAVAILABLE payout rail),
but live-outage behaviour is EXTERNAL PRODUCTION UNVERIFIED — see
`CUSTOMER_SYSTEM_CERTIFICATION.md`.
