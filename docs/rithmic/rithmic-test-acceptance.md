# Rithmic Test Acceptance (Milestone 9)

The live acceptance is driven by `pnpm --filter @atlas/server rithmic:verify`.
It is safe, credential-free in output, and honest about market-state blockers.

## Steps (in order)
1. System discovery succeeds; **"Rithmic Test" present**.
2. TICKER plant authenticates.
3. HISTORY plant authenticates (if entitled).
4. ORDER plant authenticates.
5. PNL plant authenticates (if entitled).
6. Account list returns ≥1 account.
7. Trade routes return.
8. Instrument/reference discovery succeeds.
9. Market subscription receives real data when the market/provider is live.
10. Historical request returns bars when entitled.
11. Order-update subscription succeeds.
12. (Supervised, `VERIFY_SUBMIT=1`) submit ONE non-marketable limit order.
13. Observe the authoritative provider response.
14. Cancel it if it remains working.
15. Verify Atlas state matches provider state; reconciliation returns MATCHED.

## Result recording
Each step reports PASS / BLOCKED / FAIL. Market-closed or entitlement gaps are
**BLOCKED**, never fabricated as PASS. A FAIL exits non-zero.

## Automated run in this environment
The official package and Rithmic Test credentials were **not present** in the
build/CI environment, so live steps were not executed here; the deterministic
suite (107 tests) fully exercises the protocol, connection, market-data,
execution and reconciliation logic against recorded/synthetic frames. Run
`rithmic:verify` locally after placing credentials to complete the live steps.
