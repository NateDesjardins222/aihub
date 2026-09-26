# LAUNCH GATES

**Phase 2 — System-Wide Reconciliation. Audit-only.**

Baseline HEAD: `55df4c7` · Compiled 2026-09-25.

## Gate states

- **NOT READY** — known blocker(s) open.
- **PARTIAL** — substantially built, specific gaps remain.
- **READY FOR TEST** — believed complete enough to test end-to-end; not yet proven in a real
  environment.
- **VERIFIED** — proven in the target environment with extraordinary evidence.

**Rule (from the Phase 2 mandate):** legal, payments, and security gates are **never marked
VERIFIED from code alone.** They stay at most READY FOR TEST until proven in the real
environment by the responsible owner.

---

| # | Gate | State | Why | Blocking issues |
|---|------|-------|-----|-----------------|
| G1 | **Payments in (real charge)** | **NOT READY** | Whop is sandbox-only. Phase 4 closed the fail-open (commerce now FAILS CLOSED in prod — no mock, no fake PAYMENT_SUCCEEDED; ~~HTF-1~~, ~~DR-3~~ resolved), but no real Whop production charge path exists yet | HTF-3, DR-5 |
| G2 | **Payouts out (real disbursement)** | **NOT READY** | No real payout rail exists (mock/unconfigured) | HTF-3, DR-5 |
| G3 | **KYC / identity (compliance)** | **NOT READY** | Phase 4 closed the fail-open (identity now FAILS CLOSED in prod — no mock KYC, no customer-driven VERIFIED; ~~HTF-2~~ resolved), but no real Stripe Identity path exists yet | DR-5 |
| G4 | **Authoritative product model** | **READY FOR TEST** | Phase 3: one authoritative model; DB=catalog on all fields; normal seed produces the 10; legacy retired; fresh+existing DB verified; integrity tests guard divergence. Phase 3.5: risk/payout semantics LOCKED (EOD floor locks at start, `trailingLockAtMicros=0`; breach on equity; CORE/SELECT $0 buffer; post-payout floor safe); accepted against public pricing + Owner Products + Portal; reconcile publishes new immutable versions (v2), pins preserved | ~~HTF-5, HTF-6, DR-1, DR-2~~ resolved; ~~DR-11~~ resolved (Phase 3.5); owner sign-off on values still recommended |
| G5 | **Legal / agreements / disclosures** | **NOT READY** | Agreements framework exists and is enforced, but content + the drawdown-mismatch (sold vs enforced) is unresolved; cannot be VERIFIED from code | HTF-6, DR-4; owner/legal sign-off |
| G6 | **Security / trust boundaries** | **PARTIAL** | Strong server-authority design; Phase 4 closed the fail-open providers (~~HTF-1, HTF-2~~) and gated `/design-lab` + dev seed (~~HTF-4~~); remaining: self-serve rule/reset routes + view-only kill switches | HTF-10, HTF-21 |
| G7 | **Golden Path (simulation)** | **VERIFIED (simulation)** | Phase 5: CORE 50K driven end-to-end by a durable integration harness (`golden-path.core50k.test.ts`, 15 tests) with real domain services + real engine — purchase→payment→provision→trade→risk→consistency→pass→funded→cert→winning days→payout→dev settlement→PAID→payout cert→reconciliation, all exactly-once. VERIFIED **in simulation only**; payments/KYC/payout rails remain mock/dev (arrows 1–2, 13–14) | — |
| G8 | **Trading terminal + risk engine** | **READY FOR TEST** | Server-authoritative, extensively tested; default feed is delayed/dev. Phase 6: the **Rithmic Test** market-data + execution path is proven **deterministically** (107 Rithmic + 127 md/health/exec/pnl + 100 instrument tests; connection state machine, freshness, no-dup bar merge, ack≠fill, lost-ack, reconciliation), fail-fast with **no fallback masking**; owner health truthfully reads `NOT_VERIFIED`/`verified:false`. **Live Rithmic Test acceptance (auth/tick/order round-trip) is OWNER MANUAL** — no creds in this env (see `RITHMIC_ATLAS_ACCEPTANCE.md`) | choose real feed (DR-5); run live Rithmic Test acceptance |
| G9 | **Certificates / achievements** | **READY FOR TEST** | Wired, exactly-once, immutable, real render; fulfillment mock | Prodigi if merch launches |
| G10 | **Owner OS operability** | **PARTIAL** | 22 routes load real data; safety mutations (kill switches) not surfaced | HTF-10, DR-10 |
| G11 | **Observability / alerting** | **PARTIAL** | Audit chain strong; health is liveness-only; no metrics/tracing; alerts read-only in UI | HTF-10, HTF-19 |
| G12 | **Infrastructure / deploy / backups** | **NOT READY** | No CI, no backups in-repo, no prod deploy manifests, inactivity cron unbound | HTF-16, HTF-17, HTF-18 |
| G13 | **Data integrity / idempotency** | **PARTIAL** | Very strong across payouts/commerce/certs; one affiliate-ledger gap needs revalidation | HTF-9 |
| G14 | **Affiliate program** | **READY FOR TEST** | Built end-to-end; payout provider unconfigured; ledger gap | HTF-9, DR-5 |

---

## Gate summary

- **NOT READY (6):** payments in, payouts out, KYC, product model, legal, infra/deploy.
- **PARTIAL (4):** security, Owner OS operability, observability, data integrity.
- **READY FOR TEST (4):** Golden Path (sim), terminal+risk, certificates, affiliates.
- **VERIFIED (0):** nothing — correct for this stage.

## The critical path to a first real launch

The gates cluster into three sequential bodies of work, none of which Phase 2 performs:

1. **Product truth (G4/G5/DR-1..DR-2, DR-4).** Decide the authoritative product model and
   reconcile DB/catalog/economics + seed. Everything commercial and legal depends on knowing
   what the product *is*. Cheapest and most foundational.
2. **Boundary safety (G1/G2/G3/G6/DR-3, DR-5).** Fail-close the mock providers, then wire real
   payment, payout, and KYC providers and prove each boundary. This is where "no real money"
   becomes "real money handled safely."
3. **Operate it (G10/G11/G12).** Surface the safety controls, stand up CI/backups/deploy, bind
   the cron, add health/metrics.

## PROVENANCE

Gate states derive from `SYSTEM_STATUS.md`, `KNOWN_ISSUES.md`, and `GOLDEN_PATH.md`. No gate is
marked VERIFIED; legal/payments/security are held at or below READY FOR TEST per the mandate.
