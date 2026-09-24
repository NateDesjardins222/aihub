# Customer Identity, Contact Verification, Identity Verification & Agreements — V1

The permanent human behind a Happy Trader account, the verification of how to
reach them, the verification of who they are, and the record that they agreed to
the terms. Built provider-neutral, with deterministic local/mock behaviour and a
production adapter seam that **reports itself unconfigured rather than pretending
a real verification occurred.**

> **No real provider is connected.** No Stripe Identity, Twilio, or Resend
> credentials are wired. Mock/local mode is the working default; the production
> adapters exist as seams that clearly report `unconfigured`. Passing the mock
> flow is **not** evidence that a real KYC/verification happened. This is stated
> again in the completion report.

This document is the contract for checkpoints C and D. It is deliberately written
before any implementation so the seams are agreed first, and so the reader can
tell reuse from net-new at a glance.

---

## 1. Why this exists — "EMAIL IS NOT THE PERSON"

Today the platform keys everything human off `users.id` and `users.email`
(`schema.ts:62`). Email is a login credential and a reachability channel; it is
not a durable identity. A person can change their email, verify a new phone,
accept a new agreement version, buy a product, pass an evaluation, get funded,
request a payout, open a support case, and be the subject of a risk review — and
all of that is the *same person* whether or not their email address ever changes.

So V1 introduces a **permanent customer identity** — `customer_identities.id`
(a `customer_identity_id`) — that is the stable spine every other customer-facing
fact hangs from. Email, phone, identity verification, agreement acceptance,
commerce customer mapping, purchases, entitlements, evaluation accounts, funded
accounts, payouts, and risk/support cases all reference the identity, never the
email string.

The identity does **not** replace `users`. It sits beside it:

- `users` remains the auth principal (credentials, role, org, session). RBAC,
  tokens, and `request.user` are unchanged.
- `customer_identities` is the commercial/KYC/agreement spine. One identity per
  human customer, linked 1:1 to a `users` row in V1 (the seam allows a future
  many-auth-to-one-identity, but V1 keeps it 1:1 to avoid speculative
  complexity).

Nothing in the trading engine, provisioning, or the payout engine learns about
customer identity except through the **gate predicate** (§9) that the commerce
funnel consults — documented in `commerce-provisioning-v1.md`.

---

## 2. What is reused, and what is net-new

**Reused unchanged (do not fork):**

| Concern | Source of truth |
| --- | --- |
| Auth principal, roles, sessions | `users`, `auth-plugin.ts`, `auth/service.ts` |
| Organisations / tenancy | `organizations`, `organizationId` on every row |
| Audit (hash-chained per org) | `audit.ts` `recordAudit` |
| Domain events + outbox | `events.ts` `events.publish`, `outbox.ts` `enqueueOutbox` |
| Actor model | `actor.ts` (`USER｜ADMIN｜SYSTEM｜SERVICE`) |
| Money as integer micros | `micros()` in `schema.ts` |
| Advisory-lock / `FOR UPDATE` / version-CAS mutation template | `account-service.ts`, `trading/account-lock.ts` |
| Owner console shell | `apps/web/src/admin/*` |

**Net-new in this milestone (checkpoints C, D):**

- Tables: `customer_identities`, `verified_contacts`, `contact_verification_challenges`,
  `identity_verifications`, `agreement_versions`, `agreement_acceptances`.
- Services: `platform/customer-identity.ts`, `platform/contact-verification.ts`,
  `platform/identity-verification.ts` (+ the provider abstraction and adapters),
  `platform/agreements.ts`.
- Audit subjects: extend `AuditSubject` with `CUSTOMER`, `IDENTITY`, `AGREEMENT`
  (`COMMERCE`, `NOTIFICATION` are added by the sibling milestones).
- Domain events: `identity.*`, `contact.*`, `agreement.*` (listed in §8).

---

## 3. Authoritative data model

All tables carry `organizationId` for tenancy and are additive (migration 0018).
Money, where present, is integer micros. Timestamps are `timestamptz`.

### 3.1 `customer_identities` — the spine

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | the `customer_identity_id` |
| `organization_id` | uuid FK → organizations | tenancy |
| `user_id` | uuid FK → users, **unique** | 1:1 with the auth principal in V1 |
| `status` | varchar(24) | `ACTIVE｜HOLD｜CLOSED` — operational, **not** a verification state |
| `legal_name` | text, nullable | captured at identity step; not the display name |
| `date_of_birth` | date, nullable | for identity verification; never an eligibility filter in V1 |
| `country` | varchar(2), nullable | informational; **no country eligibility list is enforced** |
| `identity_status` | varchar(24) | denormalised current verification state (§4), kept in step with the latest `identity_verifications` row under the identity's advisory lock |
| `created_at` / `updated_at` | timestamptz | |

Unique: `(user_id)`. Index: `(organization_id)`, `(organization_id, identity_status)`.

Never stored here: raw ID document images, SSN/TIN, passwords, verification codes,
raw provider payloads.

### 3.2 `verified_contacts` — reachable, proven channels

One row per (identity, channel, value). A person may have several emails/phones;
at most one of each channel is `is_primary`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `customer_identity_id` | uuid FK → customer_identities | |
| `channel` | varchar(8) | `EMAIL｜SMS` |
| `value` | varchar(254) | normalised (email lowercased; phone E.164) |
| `status` | varchar(16) | `PENDING｜VERIFIED｜REVOKED` |
| `is_primary` | boolean | one primary per channel |
| `verified_at` | timestamptz, nullable | |
| `created_at` / `updated_at` | | |

Unique: `(customer_identity_id, channel, value)`. Partial-unique intent for a
single primary per channel is enforced in the service under the identity lock
(Postgres partial unique index `WHERE is_primary` on `(customer_identity_id,
channel)`).

### 3.3 `contact_verification_challenges` — the short-lived proof

The code/token a customer must return to verify a contact. **The plaintext code
is never stored** — only a hash — and it is never returned in a production
response. In local/test mode the service exposes the code through a clearly
separate, dev-only channel (see §5.4).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `customer_identity_id` | uuid FK | |
| `channel` | varchar(8) | `EMAIL｜SMS` |
| `value` | varchar(254) | the target being verified |
| `code_hash` | text | SHA-256 of the 6-digit code + a per-row salt |
| `salt` | text | per-challenge salt |
| `status` | varchar(16) | `PENDING｜CONSUMED｜EXPIRED｜VOID` |
| `attempts` | integer default 0 | wrong-code attempts, capped |
| `max_attempts` | integer default 5 | |
| `expires_at` | timestamptz | short TTL (10 min) |
| `consumed_at` | timestamptz, nullable | |
| `created_at` | timestamptz | |

Index: `(customer_identity_id, channel, status)`. A new challenge for the same
(identity, channel, value) voids the prior `PENDING` one so only one code is live.

### 3.4 `identity_verifications` — the KYC attempt record

One row per verification attempt (a person may have several across time; the
latest terminal one drives `customer_identities.identity_status`). Stores the
**decision and provider reference**, never the documents.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `customer_identity_id` | uuid FK | |
| `provider` | varchar(24) | `MOCK｜STRIPE` — which adapter produced this |
| `provider_ref` | varchar(200), nullable | the provider's verification-session id |
| `status` | varchar(24) | verification state (§4) |
| `reason_code` | varchar(48), nullable | e.g. `DOCUMENT_UNREADABLE`, `NAME_MISMATCH`, `STEP_UP` — never a raw provider blob |
| `legal_name` | text, nullable | as returned/asserted; mirrors identity |
| `date_of_birth` | date, nullable | |
| `address_json` | jsonb, nullable | structured address; **no document images** |
| `requested_at` | timestamptz | |
| `decided_at` | timestamptz, nullable | |
| `created_at` / `updated_at` | | |

Index: `(customer_identity_id, status)`, `(organization_id, status)`,
`(provider, provider_ref)`.

### 3.5 `agreement_versions` — the versioned terms

Append-only. A material change publishes a **new** version; old versions are
never edited. Content is a clearly-labelled dev placeholder in V1 — **not**
counsel-approved legal language.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `agreement_type` | varchar(32) | `TERMS_OF_USE｜TRADER_PLEDGE｜PRIVACY｜RISK_DISCLOSURE` |
| `version` | integer | monotonically increasing per (org, type) |
| `title` | varchar(120) | |
| `body` | text | **placeholder/dev content, explicitly labelled** |
| `content_hash` | varchar(64) | SHA-256 of the exact body — the immutable identifier of what was shown |
| `is_required` | boolean | a required agreement gates trading |
| `requires_reacceptance` | boolean | material new version → prior acceptance no longer satisfies |
| `published_at` | timestamptz | |
| `created_at` | timestamptz | |

Unique: `(organization_id, agreement_type, version)`, and
`(organization_id, agreement_type, content_hash)`. A trigger rejects UPDATE/DELETE
(append-only, mirroring `payout_ledger`/`auditLog`).

### 3.6 `agreement_acceptances` — the immutable acceptance record

Append-only. One row per (identity, agreement version) acceptance event. **Never
overwritten.**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `customer_identity_id` | uuid FK | |
| `agreement_version_id` | uuid FK → agreement_versions | |
| `agreement_type` | varchar(32) | denormalised for query speed |
| `content_hash` | varchar(64) | copied from the version at acceptance — the exact thing agreed |
| `accepted_at` | timestamptz | |
| `user_id` | uuid FK | who clicked (the auth principal at the time) |
| `session_meta` | jsonb | ip, user-agent, product_version context — security metadata |
| `created_at` | timestamptz | |

Unique: `(customer_identity_id, agreement_version_id)` — a version is accepted at
most once per identity. A trigger rejects UPDATE/DELETE.

---

## 4. Identity verification state machine

States (on `identity_verifications.status`, mirrored to
`customer_identities.identity_status`):

```
UNVERIFIED
  └─ contact verified (email+phone) ──▶ CONTACT_VERIFIED
        └─ start identity verification ──▶ IDENTITY_PENDING
              ├─ provider approves ─────▶ IDENTITY_VERIFIED   (terminal-good)
              ├─ provider needs more ───▶ STEP_UP_REQUIRED ──▶ IDENTITY_PENDING
              ├─ provider holds ────────▶ UNDER_REVIEW ──▶ IDENTITY_VERIFIED | REJECTED
              └─ provider declines ─────▶ REJECTED           (terminal-bad, appealable)
```

Plus the two contact-only precursors used by the onboarding UI and the gate:

```
UNVERIFIED ──▶ CONTACT_PENDING ──▶ CONTACT_VERIFIED
```

Rules the machine must honour:

- **Every transition is explicit, audited, deterministic, and testable.** No
  status is inferred from a side effect; each is written by a named service call
  under the identity's advisory lock, with a `recordAudit` and a domain event.
- **Verified contact ≠ verified identity.** `CONTACT_VERIFIED` never grants
  identity; it only satisfies the contact half of the gate.
- **HOLD / UNDER_REVIEW is not a fraud conviction.** It is "we need a human to
  look", carries no accusation, and is reversible to `IDENTITY_VERIFIED`.
- **`REJECTED` is appealable.** It is terminal for *this attempt*; a new
  `identity_verifications` row (a re-verification) can supersede it. Reason codes
  are coarse (`DOCUMENT_UNREADABLE`, `NAME_MISMATCH`, `STEP_UP`, `MANUAL_DECLINE`),
  never a raw provider payload.
- **No SSN/TIN, no country eligibility gate.** Country is captured but never used
  to block in V1.

Illegal transitions (e.g. `IDENTITY_VERIFIED → IDENTITY_PENDING` without an
explicit re-verification request) are refused by the service.

---

## 5. Provider boundaries

The whole point of the abstraction: the domain speaks to an **interface**, and
the interface has (a) a deterministic mock that is the working default and (b) a
production adapter seam that reports `unconfigured` and never fakes a real
verification.

### 5.1 `IdentityVerificationProvider` interface

```ts
export interface IdentityVerificationProvider {
  readonly name: 'MOCK' | 'STRIPE';
  /** Is this provider actually wired to real credentials? */
  isConfigured(): boolean;
  /** Begin a verification; returns a provider ref + the initial status. */
  createVerification(input: CreateVerificationInput): Promise<ProviderVerification>;
  /** Poll/read current status by provider ref. */
  getVerificationStatus(ref: string): Promise<ProviderVerification>;
  /** Verify + normalise an inbound provider webhook/event into a status change. */
  processProviderEvent(raw: RawProviderEvent): Promise<NormalizedIdentityEvent>;
  /** Ask the provider to require a step-up / re-verification. */
  requestReverification(ref: string, reason: string): Promise<ProviderVerification>;
}
```

`ProviderVerification` normalises to `{ ref, status, reasonCode?, legalName?,
dob?, address? }` where `status` is one of the §4 states — the domain never sees
provider-specific strings.

### 5.2 `MockIdentityProvider` (the working default)

- `isConfigured()` → `true` (the mock is always "configured" as a mock).
- Deterministic outcomes driven by input, so tests and the browser flow are
  reproducible:
  - a magic legal name / flag → `IDENTITY_VERIFIED`;
  - a name containing `REVIEW` → `UNDER_REVIEW`;
  - a name containing `STEP` → `STEP_UP_REQUIRED`;
  - a name containing `REJECT` → `REJECTED`;
  - otherwise `IDENTITY_VERIFIED` after an explicit "advance" call (so the UI can
    show `IDENTITY_PENDING` first).
- `processProviderEvent` accepts a locally-minted event shape (used by the
  browser acceptance to drive a server-side status change without a real webhook).

### 5.3 `StripeIdentityProvider` (the seam)

- `isConfigured()` → `Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_IDENTITY_WEBHOOK_SECRET)`.
- Every method, when `!isConfigured()`, throws/returns a clearly-typed
  `ProviderUnconfiguredError('STRIPE_IDENTITY')`. It **never** returns a
  synthetic `IDENTITY_VERIFIED`. The server surfaces this as "identity provider
  not configured", and the customer flow cannot complete real identity in this
  environment — which is the honest state.
- The webhook verification, session creation, and event normalisation are written
  as the real Stripe shapes but guarded behind `isConfigured()`; **no live call
  is made** this milestone.

### 5.4 Selection

`identityProviderFromEnv()` returns the Stripe adapter when configured, else the
Mock. A boolean in the health/config surface (`identity: 'mock' | 'stripe'`)
tells the owner exactly which is live. **The mock being active is displayed as
`mock`, never as `verified production`.**

Contact verification providers (email/SMS send) are the notification providers
documented in `notifications-v1.md`; contact verification here owns only the
challenge lifecycle and consumes the notification abstraction to deliver the code.

---

## 6. Contact verification (email + phone)

- **Start:** `startContactVerification(db, {identityId, channel, value})` normalises
  the value, voids any live challenge for that (identity, channel, value), mints a
  6-digit code, stores only `code_hash`+`salt`, sets a 10-min TTL, and enqueues a
  notification (VERIFY_EMAIL / VERIFY_PHONE) via the outbox — **never** blocking on
  the provider. Returns `{ challengeId, expiresAt }`. In prod the response carries
  no code; in local/test mode a separate dev accessor (`__devPeekCode`, gated on
  `NODE_ENV !== 'production'`) exposes it for the harness.
- **Confirm:** `confirmContactVerification(db, {challengeId, code})` under the
  identity lock: rejects if `EXPIRED`/`CONSUMED`/`VOID`; increments `attempts` and
  voids on exceeding `max_attempts` (replay/brute-force guard); on a hash match
  marks the challenge `CONSUMED`, upserts the `verified_contacts` row to
  `VERIFIED`, sets primary if first of its channel, audits `contact.verified`,
  emits `contact.verified`. Rate-limited at the route (per identity + per IP).
- **Verified contact ≠ identity.** When both a primary EMAIL and primary SMS are
  `VERIFIED`, the identity may advance `UNVERIFIED → CONTACT_VERIFIED` — a
  distinct, audited transition, not identity.

Replay/expiration/rate-limit are all first-class: an expired or consumed code is
inert, a wrong code is counted, and a fresh request voids the old one.

---

## 7. Agreements

- **Seeding:** a startup/seed publishes version 1 of each required agreement type
  with **clearly-labelled placeholder content** (e.g. body begins
  `> DEVELOPMENT PLACEHOLDER — not legal advice, not counsel-approved.`).
  `content_hash` is computed from the exact body.
- **Acceptance:** `acceptAgreements(db, {identityId, versionIds, userId,
  sessionMeta})` writes one immutable `agreement_acceptances` row per version
  (unique on `(identity, version)` makes a double-submit a no-op), copies the
  `content_hash`, records `session_meta`, audits `agreement.accepted`, emits
  `agreement.accepted`. Never overwrites a prior acceptance.
- **Requirement query:** `outstandingAgreements(db, identityId)` returns the
  required agreement types whose **current** version is not yet accepted by this
  identity (accounting for `requires_reacceptance` on newer versions). This is the
  agreement half of the gate.
- **Re-acceptance:** publishing a new version with `requires_reacceptance = true`
  means the prior acceptance no longer satisfies the requirement; the identity is
  surfaced in the onboarding UI and (if already trading) flagged in the owner
  console's Agreement Block queue. V1 does not auto-suspend existing accounts on a
  new version — it surfaces the block; suspension is an owner action.

---

## 8. Domain events & audit actions added

**Domain events** (added to `DomainEventType` in `events.ts`):

```
customer_identity.created
contact.challenge_started
contact.verified
identity.verification_started
identity.step_up_required
identity.under_review
identity.verified
identity.rejected
agreement.accepted
```

Each is published inside the same transaction that made the change (row written
first, subscribers are bystanders), so a notification worker or the owner console
can react without the domain depending on them.

**Audit** (`AuditSubject` extended with `CUSTOMER｜IDENTITY｜AGREEMENT`): every
service mutation writes a `recordAudit` with the actor, the before/after state,
and a reason where one applies. Never logged: raw codes, document images, provider
secrets, full provider payloads.

---

## 9. The gate predicate (how identity meets commerce)

The commerce funnel (`commerce-provisioning-v1.md`) consults a single, pure-ish
predicate before it provisions an evaluation from a paid order:

```ts
export interface ProvisioningGate {
  identityOk: boolean;      // identity_status === IDENTITY_VERIFIED
  contactOk: boolean;       // primary email + phone VERIFIED
  agreementsOk: boolean;    // outstandingAgreements === []
  blockedReasons: string[]; // e.g. ['IDENTITY_UNVERIFIED','AGREEMENT_MISSING:TERMS_OF_USE']
}
export function evaluateProvisioningGate(db, identityId): Promise<ProvisioningGate>;
```

- The gate is **read-only** and side-effect-free; it never provisions.
- The commerce funnel calls it; if not `identityOk && contactOk && agreementsOk`,
  the paid order is **parked recoverably** (never lost, never a browser-driven
  provision) — the mechanics live in `commerce-provisioning-v1.md` §Gate.
- The trading terminal separately refuses to enable a *funded/eval* account whose
  identity gate is not satisfied — but the authoritative enforcement is the
  commerce funnel, not the client.

This is the only coupling between customer identity and the trading/commerce
authority. Identity never reaches inside the rule engine or provisioning.

---

## 10. Idempotency & concurrency

- **Identity creation** is idempotent on `(user_id)` (unique) — a race to create
  two identities for one user resolves to one via `onConflictDoNothing` + re-read,
  mirroring `createPendingOrder`.
- **Every state transition** takes the identity's transaction-scoped advisory
  lock (a dedicated CLASSID in the `account-lock.ts` two-int space, so it never
  collides with account locks) + `SELECT … FOR UPDATE` on the identity row, then a
  guarded update (`WHERE identity_status = <expected>`), so two concurrent
  provider events converge and illegal transitions are refused.
- **Contact challenges** are single-live-per-target; confirm is guarded and
  attempt-capped.
- **Agreement acceptance** is unique per (identity, version) — concurrent
  double-accept is a no-op.
- No floats anywhere; no money in these tables except `identity_verifications`
  carries none — money lives only in the commerce/payout tables.

---

## 11. Security boundaries

- **Tenancy:** every query filters by `organizationId`; the owner console and the
  customer routes both scope to the caller's org. IDOR tests assert a customer
  cannot read/modify another identity, and support cannot cross orgs.
- **PII minimisation:** legal name / DOB / address are stored structured; **no ID
  images, no SSN/TIN, no raw provider payloads, no codes** are persisted or logged.
- **Codes** are hashed at rest, rate-limited, attempt-capped, TTL'd, and never in
  a production response.
- **RBAC:** customers act only on their own identity; SUPPORT reads; ADMIN takes
  controlled actions (require reverification, place/release hold) with a reason +
  audit; SUPER_ADMIN for the most sensitive. No role can edit a raw secret or
  rewrite an acceptance.
- **No invasive fingerprinting.** Only account-bound, first-party telemetry
  (ip/user-agent on acceptance, provider ref) — no cross-internet device
  tracking.

---

## 12. Failure recovery

- A provider being unconfigured is a **first-class, visible state**, not an error
  that silently passes. The customer flow stops honestly at "identity provider not
  configured" in this environment.
- A verification stuck in `IDENTITY_PENDING`/`UNDER_REVIEW` appears in the owner
  **Identity Review** queue; an owner can require reverification or (with strong
  evidence and a reason) advance/reject — all audited.
- A lost contact challenge is inert; the customer simply requests a new code.
- A crash between "provider approved" and "identity_status written" is recovered
  by re-reading the provider status (idempotent `getVerificationStatus` +
  guarded write), and by a startup reconcile that re-drives `IDENTITY_PENDING`
  rows whose provider ref reports a terminal status.

---

## 13. Owner operations (console, checkpoint J)

The Customer/Commerce area (extending `apps/web/src/admin`) surfaces, per
customer identity: identity status + history, verified contacts, agreement
acceptances (with content hashes), and the audit trail. Controlled actions
(RBAC + reason + audit + event): **require reverification**, **place/release
hold**, **mark contact revoked**. Exception queue: **Identity Review**
(everything in `UNDER_REVIEW`/`STEP_UP_REQUIRED`) and **Agreement Block**
(identities missing a now-required agreement).

---

## 14. Browser acceptance plan (this doc's slice of section 40)

Driven by the harness (`tests/browser/harness.mjs`) against the mock providers:

1. Create account / sign in → a `customer_identities` row exists for the user.
2. Verify email (local code via dev accessor) → primary EMAIL `VERIFIED`.
3. Verify phone (local code) → primary SMS `VERIFIED`; identity advances to
   `CONTACT_VERIFIED`.
4. Enter personal/identity info → `legal_name`/`dob` captured.
5. Mock identity verify → `IDENTITY_VERIFIED`, audited, event emitted.
6. Accept the seeded agreements → immutable acceptances with content hashes;
   `outstandingAgreements` becomes empty.
7. The gate predicate returns `identityOk && contactOk && agreementsOk`.
8. Negative: with an agreement missing, the gate reports `AGREEMENT_MISSING` and
   (proven in the commerce doc's slice) a paid order parks instead of
   provisioning.

Screenshots and a JSON artifact are captured per the harness `createReport`.

---

## 15. Explicitly not built (this doc)

Real Stripe Identity calls, SSN/TIN capture, country eligibility enforcement,
document-image storage, biometric checks, cross-internet device fingerprinting,
final counsel-approved legal text. All are seams or placeholders, clearly labelled.
