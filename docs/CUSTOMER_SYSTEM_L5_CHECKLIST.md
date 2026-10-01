# Customer System L5 Checklist

The "Level 5 / would-I-bet-the-company-on-it" checklist for the customer business
system. Each item is a yes/no a reasonable operator would demand before launch,
with the proof. All items below are satisfied for the INTERNAL software; external
provider items are called out as pending.

1. **One payment, one account** — duplicates/replays/concurrency/crash all converge
   to a single account. ✓ `commerce-chaos.test.ts`
2. **No money black holes** — a paid order that can't provision is visible,
   recoverable, and detected. ✓ `INV_STRANDED_PURCHASE`
3. **Only verified payments provision** — browser success page is inert; webhook
   signature is the sole authority. ✓ `whop.ts`, webhook tests
4. **Five-account cap is unbreakable** — advisory-locked; display matches
   enforcement. ✓ `account-limit.test.ts`, §4D
5. **No cross-customer leakage** — REST, order path, portal, WS all deny. ✓
   `golden-path.security.test.ts`
6. **Atlas shows only owned accounts** — one authoritative row, owner-scoped. ✓
7. **Handoff is honest** — an unavailable requested account is surfaced, never
   silently swapped. ✓ `account-selection.test.ts` (§4A)
8. **Dead accounts can't trade** — ACTIVE/GOAL_REACHED only. ✓ `risk.ts`
9. **Money is exact** — integer micro-dollars; no float, no `$NaN`/`-0`. ✓
10. **Payout pays once** — single DEBIT, unique ledger index. ✓
    `payout-ops-torture.test.ts`
11. **Payout crash-safe** — reversal/fail crash reconciles with no stranded debit.
    ✓ `payout-reversal-crash.test.ts`
12. **Five cycles then done** — 6th blocked; account completes. ✓
13. **Rewards are exactly-once** — certs/achievements `(org,dedupeKey)`; clubs use
    PAID trader-share only; goals can't be forged. ✓ `recognition.test.ts`,
    `personal-goals.test.ts`
14. **Owner can operate without SQL** — every launch-critical object has a surface
    reading the same authoritative record. ✓ `OWNER_OPERABILITY_MATRIX.md`
15. **Support & affiliate reach the owner** — same row both sides; affiliate apply
    deduped on both paths. ✓ `affiliate-lifecycle.test.ts` (§4C)
16. **Error is never zero** — failed fetches show error/unknown, not fake
    zeros/empties. ✓ `metric-display.test.ts` (§4B)
17. **Corruption is detectable** — read-only detectors, no false positives, every
    offender counted. ✓ `customer-product-integrity.test.ts` (§7/§73)
18. **Restart preserves truth** — all customer state reconstructed from the DB. ✓
    commerce-chaos/resilience
19. **One command certifies it** — `pnpm customer:certify` FAST+DEEP, nonzero on
    failure, refuses production. ✓ `customer-certify.ts`
20. **The boundary is honest** — internal software certified; external production
    providers explicitly UNVERIFIED and never claimed. ✓
    `CUSTOMER_SYSTEM_CERTIFICATION.md`

**Pending (external, not this phase):** real Whop-production / payout rail / KYC /
Rithmic / object storage / email, and Nathan's human-acceptance walkthrough
(`CUSTOMER_SYSTEM_LAUNCH_GATES.md` LG-X1..X5).
