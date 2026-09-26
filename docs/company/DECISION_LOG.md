# DECISION LOG

**Phase 2 — System-Wide Reconciliation. Audit-only.**

Baseline HEAD: `55df4c7` · Compiled 2026-09-25.

Two kinds of entry:
- **PROVEN** — a decision the code already embodies, with evidence. Recorded so it is not
  re-litigated.
- **DECISION REQUIRED** — a real fork the code cannot resolve on its own; an owner must
  decide. **Phase 2 explicitly does not decide these.**

---

## DECISIONS REQUIRED (owner input needed)

### DR-1 — Authoritative product model: DB vs catalog (the four divergences)
✅ **RESOLVED (Phase 3, 2026-09-26).** The owner's Phase 3 brief supplied the locked V1
values (the decision). Implemented: one authoritative model
(`packages/contracts/src/product-model.ts`) that DB seed, reconciliation and economics all
consume; DB reconciled to catalog for every field. Guarded by product-integrity tests.
The runtime authority (DB) and the public site/catalog disagree on four properties
(`PRODUCT_SOURCE_OF_TRUTH.md`): drawdown TYPE (STATIC vs EOD_TRAILING, all 10 HTF), CORE 300K
target ($18,000 vs $15,000), CORE 300K drawdown ($12,000 vs $10,000), SELECT drawdown (4% vs
5%). Customers are **shown catalog values but provisioned DB values**, and the economics
engine models catalog values. **Decision needed:** the single authoritative value per
property, then reconcile all sources to it. **Do not resolve silently** (explicit Phase 2
constraint). *Related issues: KNOWN_ISSUES HTF-6.*

### DR-2 — Canonical seed / the 27-profile duplication
✅ **RESOLVED (Phase 3).** Canonical seed = the HTF catalog via `reconcileHtfProducts`, run
by the normal `db:seed`. The 7 legacy templates are RETIRED (not deleted); practice-150k kept
INTERNAL for the terminal. Fresh + existing-DB paths verified idempotent.
The default `db:seed` produces the legacy Atlas/Practice catalog (payout-incompatible rule
shapes); the 10 HTF products come from a separate manual script. The DB holds 27 profiles (10
HTF + 10 funded + 7 legacy). **Decision needed:** which seed is canonical; whether to retire
the 7 legacy templates (`setProfileStatus RETIRED` — non-destructive). **Do not resolve
silently** (explicit Phase 2 constraint on the product-duplication issue). *HTF-5.*

### DR-3 — Fail-open providers: fail closed in production? — ✅ RESOLVED (Phase 4)
`commerceProviderFromEnv` and `identityProviderFromEnv` fell back to a mock in production with
no guard, unlike the payout registry.

✅ **RESOLVED (Phase 4): fail closed.** A central provider-safety boundary
(`apps/server/src/config/provider-safety.ts`) resolves every mock-capable capability to
REAL / MOCK / UNAVAILABLE with one rule — **production never silently selects a mock**. The
commerce, identity and notification factories now consume it: in production without real config
they return the real (unconfigured) seam, which fails closed (commerce webhook 503s / mock
payment simulation throws `MOCK_COMMERCE_FORBIDDEN`; identity seam throws so no fabricated
`VERIFIED`; notifications mark messages SUPPRESSED, never a faked SENT). Mocks remain the
development/test default. This removes the fail-open **only**; it does NOT connect real
providers — commerce (Whop prod), KYC (Stripe Identity) and payouts remain UNCONFIGURED and are
not production-ready (HTF-3, DR-5). *HTF-1, HTF-2 resolved.*

### DR-4 — Drawdown-vs-consistency and SELECT differentiator
✅ **RESOLVED (Phase 3).** Risk mechanic = EOD_TRAILING for all families; SELECT's wider 5%
drawdown ($1,250/$2,500/$5,000) is the real differentiator and is now in the DB. Note the
EOD-trailing lock threshold (`trailingLockAtMicros`) was under-specified by the brief; Phase 3
set it to `null` (trail to high-water mark) as the literal reading — now **resolved in Phase 3.5
to lock at the starting balance (`0`)**; see **DR-11** below.
D-1 (STATIC vs EOD_TRAILING) and D-4 (SELECT 4% vs marketed 5% "room to breathe") are not
just numbers — they define the product's risk personality and its marketing claims.
**Decision needed:** confirm the intended risk mechanic per family and whether SELECT's wider
drawdown is a real differentiator; then align DB, catalog, and engine.

### DR-5 — Real payment + payout + KYC providers (go-live wiring)
No real charge path (Whop sandbox-only), no real payout rail, no real KYC (mock). **Decision
needed:** provider choices, contracts, and the order of wiring. Large explicit milestones,
out of Phase 2 scope. *HTF-3.*

### DR-6 — Contract-limit representation (minis/micros vs maxContracts)
✅ **RESOLVED (Phase 3).** Canonical model: `maxContracts` = the **mini** limit, with
`microsCountAsFraction=true` so 10 micros = 1 mini (existing `@atlas/instruments`
`contractWeight`). Every catalog account satisfies `micros = 10 × minis`, enforced by an
invariant + integrity test. The existing risk gate is the single server-authoritative
enforcer of mixed mini/micro exposure.

### DR-11 — EOD-trailing lock threshold (RESOLVED, Phase 3.5)
The locked V1 brief states an EOD trailing drawdown *amount* but no lock point (where the
trailing floor stops following the high-water mark). Phase 3 set `trailingLockAtMicros=null`
(the floor trails to the HWM for the account's life — the literal reading, and fail-safe
toward firm risk) and flagged the launch decision.

✅ **RESOLVED (Phase 3.5, owner-directed):** launch V1 **locks the floor at the starting
balance** once the high-water mark has risen by the full drawdown amount —
`EVAL_TRAILING_LOCK_AT_MICROS = 0` in `@atlas/contracts` (`product-model.ts`), applied to
every evaluation and funded profile. Worked example (CORE 50K, $2,000 DD): the floor starts at
$48,000, ratchets **only at the finalized EOD roll** off the closing balance
($51,000 close → $49,000 floor; $52,000 close → $50,000 floor), then **locks at $50,000**
(= starting balance) and never rises again nor moves backward. The engine already implemented
this exactly (`floorFor` caps the anchor at `startingBalance + trailingLockAtMicros`;
`rollTradingDay` ratchets on the finalized close); Phase 3.5 changed only the product-config
value (`null` → `0`) and locked it with tests. Reconciliation published this as a **new
immutable version (v2)** per profile; accounts already pinned to v1 keep their v1 terms.

The sub-questions flagged with DR-11 are also resolved for V1, from existing code — not invented:
- **Post-payout floor:** a payout must not reset or loosen the drawdown floor, and the
  withdrawable amount must not breach it. Verified by construction:
  `grossWithdrawableMicros = max(0, totalNetProfit − protectedMicros)` (`payout-core.ts`)
  only ever pays *realized profit above the protected balance*; it does not touch
  `drawdownFloorMicros`. Locked with a Phase 3.5 test.
- **CORE / SELECT initial funded buffer = $0.** SELECT's protection is its 40% payout
  consistency threshold, which **delays** a payout rather than failing the account; it is not
  a balance buffer. DAILY keeps its progressive buffers ($1,000 / $2,000 / $4,000).
- **Intraday breach semantics (EOD trailing):** the authoritative breach metric is **equity**
  (`evaluateRules`: `remainingDrawdown = equityMicros − drawdownFloorMicros`). The *current*
  floor is enforced intraday against equity, but the floor **does not ratchet from intraday
  unrealized gains** — it only advances at the finalized EOD roll. Floor movement and breach
  enforcement are kept distinct. See `ACCOUNT_STATE_MACHINE.md`.

### DR-7 — Active-account slot policy
Should LOCKED (day-lock) and GOAL_REACHED accounts count toward the 5-active limit? Today they
don't (`HTF-8`). **Decision needed:** the intended counting rule.

### DR-8 — M2M provisioning limit bypass
The M2M `/provisioning/accounts` path bypasses the active-limit and commerce invariants.
**Decision needed:** is that intentional policy for firm/partner provisioning, or an
oversight to gate? *HTF-7.*

### DR-9 — Economics v1 retirement
v2 (M13) supersedes v1 but v1 is still in the nav and reused for its PRNG. **Decision
needed:** retire v1 (keep only `mulberry32`) or keep both.

### DR-10 — Owner-OS safety-control exposure
Kill switches, feature flags, alerts, incidents, and staff lifecycle/impersonation are
backend-only or view-only in the console (`HTF-10`). **Decision needed:** which to surface
(kill switches strongly recommended) and in what priority.

---

## PROVEN DECISIONS (embodied in code, evidence-backed)

### PD-1 — Money is integer micro-dollars, computed server-side only
$1 = 1,000,000 micros; the browser may request but never assert money; the engine is the sole
authority. *Evidence: `engine.ts:1-11,1833`, `payout-core.ts`.*

### PD-2 — Trading is a simulation; no real money moves
Execution is simulation-only in the wired path; balances are paper; marketing states trading
is simulated. *Evidence: `execution/provider.ts`, `HomePage.tsx:266`.*

### PD-3 — Provisioning is authorized only from a verified server-side event, never the browser
Checkout success never grants anything; only a signature-verified webhook (or verified mock
event) provisions. *Evidence: `CheckoutApp.tsx:8-11`, `commerce.ts:147-153`.*

### PD-4 — Payout debit happens exactly once, at APPROVED, with structural double-debit protection
Single debit under lock + version CAS + unique `(request, entry_type)` ledger key.
*Evidence: `payouts.ts:445-459`.*

### PD-5 — Audit log is append-only and hash-chained; DB refuses UPDATE/DELETE
Per-org chain, `verifyAuditChain` walks it. *Evidence: `audit.ts`, migration 0006.*

### PD-6 — Product config is immutable + versioned; economics runs are immutable
Append-only profile versions; insert-only `economics_runs`. *Evidence: `profiles.ts:189-261`,
schema.*

### PD-7 — Real providers fail fast or fail closed (payout, market data, execution, storage)
Rithmic/Databento fail-fast if selected unconfigured; payout mock refused in prod; S3 seam
throws until configured. *Evidence: `bootstrap.ts`, `payout-provider-registry.ts`,
`object-store.ts`.* **Exception:** commerce + identity selectors fail open (see DR-3).

### PD-8 — Production boot guard
Server exits (code 78) if `NODE_ENV=production` with the dev JWT secret or `CORS_ORIGIN=*`.
*Evidence: `config/env.ts:251-272`.*

### PD-9 — Real-time fan-out uses Postgres LISTEN/NOTIFY + transactional outbox, not Redis
Redis is declared but unused. *Evidence: `outbox.ts`, `account-notify.ts`, docker-compose
comment.*

### PD-10 — Certificates issue exactly-once from four live triggers; issuance survives payout return
`evaluation.qualified`, `account.funded`, `payout.paid`, `account.completed`; a returned
payout never deletes cert history. *Evidence: `recognition.ts`, `payout-operations.ts:535`.*

---

## PROVENANCE

DECISIONS REQUIRED derive from the confirmed divergences and flagged findings in
`PRODUCT_SOURCE_OF_TRUTH.md` and `KNOWN_ISSUES.md`. PROVEN DECISIONS are cited from source.
No decision listed here was made or reversed during Phase 2.
