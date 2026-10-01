# Customer System Invariant Ledger

Every customer-facing invariant the business system must hold, where it is
enforced (authoritatively, server-side), and the proof that holds it. This is the
contract the hardening phase certifies. Enforcement is in `apps/server`; proofs
are vitest suites unless noted. Nothing here changes trading economics.

Legend: **ENF** = enforcement site · **PROOF** = the test(s) that would fail if the
invariant broke.

## IDENTITY

- **INV-IDENTITY-1** One durable identity per user. `customer_identities.user_id`
  is UNIQUE; ownership keys off the identity/user, never email, so an email change
  preserves everything.
  ENF `db/schema.ts` (`customer_identities` unique) · PROOF `customer-identity*.test.ts`,
  `portal-lifecycle.test.ts`.
- **INV-IDENTITY-2** Certificate recipient name derives from the authoritative
  identity (`safePublicDisplayName`), never fixture text. ENF `recognition.ts` /
  certificate renderer · PROOF certificate tests; `CUSTOMER_SURFACE_TRUTH_MATRIX.md`.

## OWNERSHIP

- **INV-OWN-1** Order, entitlement and provisioned account share ONE owner.
  ENF provisioning path · PROOF `INV_OWNERSHIP_MISMATCH` detector
  (`integrity.ts`) + `customer-product-integrity.test.ts` (detects cross-owner;
  does not flag same-owner/unconsumed).
- **INV-OWN-2** Cross-customer reads are denied everywhere: REST, order path,
  portal mutations, WS subscriptions (404/deny). ENF route guards, `gateway.ts
  mayFollowAccount` · PROOF `golden-path.security.test.ts`.

## PURCHASE → ACCOUNT

- **INV-PUR-1** One verified payment → exactly one account. Idempotent at four
  layers (provider-event id, order idem key, entitlement `(order,kind)`,
  provisioning key). ENF `commerce.ts markOrderCompleted`, `provisioning.ts`,
  unique indexes · PROOF `commerce-chaos.test.ts` (duplicate/replay/concurrent/crash).
- **INV-PUR-2** Only a signature-verified webhook completes an order; the browser
  success page is inert. ENF `whop.ts verifyStandardWebhook` · PROOF whop webhook tests.
- **INV-PUR-3** No paid order is silently lost: it parks in
  PROVISION_BLOCKED/FAILED with audit + events + a recovery sweep, and
  `INV_STRANDED_PURCHASE` surfaces any order unprovisioned past the window.
  ENF `setProvisionState`, sweep · PROOF `customer-product-integrity.test.ts`.

## ACCOUNT CAP

- **INV-ACCT-1** At most `MAX_ACTIVE_ACCOUNTS` (5) active accounts per owner,
  enforced under `pg_advisory_xact_lock`. The portal REPORTS the same constant.
  ENF `account-limit.ts assertActiveSlotAvailable`, `portal-accounts.ts`
  (imports `MAX_ACTIVE_ACCOUNTS`, §4D) · PROOF `account-limit.test.ts`,
  `portal-lifecycle.test.ts`.

## ATLAS (account ↔ terminal)

- **INV-ATLAS-1** One authoritative `accounts` row; Atlas reads it owner-scoped by
  `accounts.userId` and never creates ownership. ENF `/api/v1/accounts` · PROOF
  `golden-path.security.test.ts`.
- **INV-ATLAS-2 (§4A)** An explicit Portal handoff selects exactly the requested
  account after ownership verification, or surfaces that it is unavailable — it
  never silently substitutes another account. ENF
  `apps/web/src/state/account-selection.ts resolveAccountSelection` · PROOF
  `account-selection.test.ts` (8 cases).
- **INV-ATLAS-3** Tradability is gated server-side (ACTIVE/GOAL_REACHED only).
  ENF `risk.ts checkOrder` · PROOF risk/golden-path tests.

## TRADE / RISK

- **INV-RISK-1** Money is integer micro-dollars end to end; no floats in financial
  columns; formatter never emits `$NaN`/`-0`. ENF schema + `format.ts` · PROOF
  `pnl-merge.test.ts`, money-state tests.
- **INV-RISK-2** A locked/failed account cannot trade; risk lock never leaves a
  position open. ENF `risk.ts`, EOD engine · PROOF engine/resilience tests.

## LIFECYCLE

- **INV-LIFE-1** Pass → funded is exactly-once (`fund:<qualId>`); qualification is
  unique `(account, lifecycle)`. ENF `commerce.ts` / `approveFunding` · PROOF
  commercial-account-lifecycle tests.

## PAYOUT

- **INV-PAY-1** Customer request and owner queue are the SAME `payout_requests`
  row. ENF payout domain · PROOF `payout-ops-torture.test.ts`.
- **INV-PAY-2** Exactly one DEBIT at approve (unique `(payoutRequestId, entryType)`
  on the append-only ledger). ENF `payout-core.ts`, unique index · PROOF
  `INV_NO_DOUBLE_DEBIT` + `INV_PAID_PAYOUT_HAS_DEBIT` detectors,
  `payout-ops-torture.test.ts`, `payout-reversal-crash.test.ts`.
- **INV-PAY-3** 5 cycles max (`MAX_PAYOUT_CYCLES`); the 5th completes the account
  and blocks a 6th. ENF `payout-core.ts` · PROOF `INV_PAYOUT_CYCLES`, payout tests.
- **INV-PAY-4** Clubs/lifetime use cumulative PAID trader-share only. ENF
  recognition/progress · PROOF `recognition.test.ts`, `personal-goals.test.ts`.

## CERTIFICATE / PROGRESS

- **INV-CERT-1** Certificates & achievements issue exactly once via unique
  `(org, dedupeKey)` + `onConflictDoNothing`. ENF `recognition.ts` · PROOF
  `recognition.test.ts`.
- **INV-PROG-1** Tracked goals cannot be forged; progress derives from
  authoritative PAID state. ENF `personal-goals.ts` · PROOF `personal-goals.test.ts`.

## SUPPORT / AFFILIATE

- **INV-SUP-1** A customer ticket is the same row the owner inbox shows; IDOR
  guarded; four-eyes on remediation. ENF support domain · PROOF support tests,
  `INV_REMEDIATION_FOUR_EYES`.
- **INV-AFF-1 (§4C)** One affiliate application per applicant: by user id for the
  logged-in path, by email for the anonymous path; DECLINED may re-apply. ENF
  `affiliates.ts submitApplication` · PROOF `affiliate-lifecycle.test.ts`.

## HONESTY (error ≠ zero)

- **INV-HON-1 (§4B)** A failed fetch is never rendered as an authoritative zero.
  The top-level accounts fetch shows an error banner; the dashboard payout badge
  shows "—" on error, distinct from a real "0". ENF `PortalApp.tsx`,
  `metric-display.ts` · PROOF `metric-display.test.ts`.

## AUDIT / RECONCILIATION

- **INV-AUD-1** The audit chain is intact and append-only. ENF audit domain ·
  PROOF `INV_AUDIT_CHAIN_INTACT`.
- **INV-RECON-1** Read-only integrity detectors surface provenance corruption
  (stranded purchase, orphan account, ownership mismatch) without false positives
  and counting every offender. ENF `integrity.ts` · PROOF
  `customer-product-integrity.test.ts` (9 cases incl. false-positive + multi-corruption).
