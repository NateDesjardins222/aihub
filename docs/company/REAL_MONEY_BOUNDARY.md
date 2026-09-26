# REAL MONEY BOUNDARY

**Happy Trader Funding — the exact conditions required before real customer money moves.** Phase 12
(2026-09-26). This document is the single, unambiguous definition of what separates the current
simulation from (a) the first real customer purchase and (b) the first real customer payout.

> Today **no real money moves anywhere** (`MONEY_FLOW.md`). Commerce/KYC/payout are mock/seam and
> **fail closed in production** (Phase 4). Every condition below is a gate, not a suggestion. None may be
> waived to "move faster." Owners: CLAUDE (software), NATE (human/business), COUNSEL, PROVIDER,
> INFRASTRUCTURE.

## The two boundaries

There are exactly two money boundaries, and they are independent — real purchase can be enabled before
real payout, but **real payout must never be enabled before real purchase + everything purchase needs**.

---

## Boundary A — FIRST REAL CUSTOMER PURCHASE

Money flows **in** (a customer is charged). Required, all of them:

### Software / config (owner: CLAUDE — mostly done)
1. Commerce provider fail-closed in production — **DONE** (Phase 4; `MOCK_COMMERCE_FORBIDDEN`).
2. Signature-verified webhook is the ONLY provisioning trigger — **DONE** (Phase 8; browser never provisions).
3. Purchase idempotency + event dedup (`commerce_events`) — **DONE** (Phase 8/9).
4. Refund path + duplicate-event protection — **DONE** (record + entitlement revoke + hold).
5. Production config validation fails fast; no dev routes/seed/mock in prod — **DONE** (Phase 10/11).
6. `WHOP_*` production credentials wired via the fail-closed selector — **NOT DONE** (needs real account).

### Business / human (owner: NATE)
7. Legal entity formed (name, state, EIN) — **NOT DONE** (human).
8. Business bank account / settlement destination — **NOT DONE** (human).
9. Whop production account approved + product/plan IDs created — **NOT DONE** (human/provider).
10. Production owner security (no seed password; MFA) — **NOT DONE** (see G6/PART 20-21).

### Legal (owner: COUNSEL)
11. Counsel-reviewed Terms, Privacy, Refund Policy, Risk Disclosure, Trader/Evaluation Agreement —
    **NOT DONE** (drafts at most; `LEGAL_COUNSEL_REVIEW_PACKAGE.md`).
12. Simulated-trading + service language approved (no "brokerage/live capital/investment") — **NOT DONE**.

### Infrastructure (owner: INFRASTRUCTURE/NATE)
13. Production hosting + managed Postgres + automated backups/PITR — **NOT DONE** (G12).
14. Domain + TLS + secret manager — **NOT DONE**.
15. Monitoring + alert delivery + reconciliation visible to owner — **PARTIAL** (health/System Doctor done;
    alert delivery channel not wired).

### Acceptance
16. Human Golden Path acceptance (Nate completes a real purchase→provision on staging) — **NOT DONE**.

**FIRST REAL PURCHASE READY: NO.** The internal software path is strong; every remaining item is
business/legal/infra/human/provider, not code.

---

## Boundary B — FIRST REAL CUSTOMER PAYOUT

Money flows **out** (Happy Trader disburses to a trader). Strictly stronger — requires **everything in
Boundary A PLUS**:

### Software / config (owner: CLAUDE — mostly done)
1. Payout engine: single balance debit, unique `(request, entry_type)`, 90/10 round-half-even,
   cycle-count-once, 5-PAID completion, lost-ack → no blind re-pay — **DONE** (Phase 9).
2. Payout-ops worker resubmits PAYABLE durably; reconciliation — **DONE/PARTIAL** (worker wired Phase 11;
   periodic stale-reconcile still cron/webhook — HTF-26).
3. Payout provider fail-closed in production (no mock PAID) — **DONE** (Phase 4).
4. Real payout provider ADAPTER wired behind the registry — **NOT DONE** (no provider selected).

### Business / human / provider (owner: NATE / PAYOUT PROVIDER)
5. Real payout provider selected + business account approved — **NOT DONE**.
6. Recipient (destination) verification + destination-change security — **PARTIAL** (destination model
   exists; provider verification not wired).
7. Production KYC (Stripe Identity) live: no payout without a real identity decision — **NOT DONE** (G3).
8. Business funding source / reserves for payouts — **NOT DONE** (human/business).

### Legal / accounting (owner: COUNSEL / CPA)
9. Payout language + tax/1099 handling reviewed — **NOT DONE**.
10. Payout incident runbook + unknown-state procedure adopted — **DONE (documented)** (`INCIDENT_RUNBOOK.md`).

**FIRST REAL PAYOUT READY: NO.**

---

## Invariants that must hold at BOTH boundaries (already true in code)
- No provisioning from a browser success screen; only a verified server event.
- No fabricated `PAYMENT_SUCCEEDED` / `IDENTITY_VERIFIED` / `PAID` in production (fail-closed).
- Every money mutation audited (hash-chained, append-only).
- Kill switches can halt purchases, provisioning, payout requests, and payout submission (durable).
- No operation requires Claude editing PostgreSQL by hand.

## The one-line rule
**Real money is enabled only when the code path is fail-closed-proven (it is), AND the business entity,
bank, counsel-approved documents, production provider credentials, production infrastructure, owner
security, and human Golden Path acceptance are all in place.** Missing any one → the boundary stays shut.
