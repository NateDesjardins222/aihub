# Certificates & Achievements — V1 (privacy model + architecture)

Event-driven, idempotent, privacy-controlled recognition. Certificates are
shareable and publicly verifiable without exposing sensitive identity data;
achievements are restrained (not a game economy) with per-trader visibility
control.

---

## 1. Certificates

### 1.1 Data model — `certificates` (net-new, append-only)

| Column | Notes |
| --- | --- |
| `id` uuid PK | |
| `organization_id` | tenancy |
| `certificate_public_id` | `HT-C-XXXX` immutable public id |
| `verification_token` | random URL-safe slug for `/verify/:token` (QR-compatible) |
| `type` | `EVALUATION_PASSED｜FUNDED_TRADER｜PAYOUT｜ACCOUNT_COMPLETED` |
| `customer_identity_id` | reference (never exposed publicly) |
| `account_id` | reference |
| `public_display_name` | SAFE name (e.g. "Nathan D.") — see §1.4 |
| `amount_micros` | nullable (payout amount, completion total) |
| `issued_at` | |
| `status` | `ISSUED｜REVOKED` |
| `revoked_reason` | nullable |
| `template_version` | e.g. `v1` |
| `dedupe_key` | unique per triggering event (exactly-once) |
| `created_at` | |

Unique `(organization_id, dedupe_key)` and `(verification_token)`. Append-only
(a trigger rejects UPDATE except the controlled revoke path, or revoke is a
status column written under audit — chosen: a narrow updatable `status`/`revoked`
with audit, since revocation is required).

### 1.2 Issuance (event-driven, idempotent)

A deferred subscriber (bystander, off the publishing call stack, like the prior
milestone's subscribers) issues certificates on authoritative events:
- `evaluation.qualified` → EVALUATION_PASSED (dedupe `pass:<qualId>`)
- `account.funded` → FUNDED_TRADER (dedupe `funded:<accountId>`)
- `payout.paid` → PAYOUT (dedupe `payout:<payoutRequestId>`)
- account COMPLETED (5 payouts) → ACCOUNT_COMPLETED (dedupe `complete:<accountId>`)

`onConflictDoNothing` on `dedupe_key` makes issuance exactly-once under duplicate
events. Each issuance audits + emits `certificate.issued` (a new event → the
notification consumer can notify).

### 1.3 Customer surface

Per certificate: VIEW, SHARE (copy verification link), SAVE IMAGE / DOWNLOAD
(client-rendered from the certificate data; an SVG/PNG the browser produces —
no sensitive data embedded), COPY VERIFICATION LINK. Listed on the dashboard,
account detail, and a Certificates area.

### 1.4 Privacy — public display name

`public_display_name` is a SAFE, trader-chosen or derived name (first name +
last initial, e.g. "Nathan D."), **never** the legal full name, email, phone,
address, KYC data, or private ids. Derived at issuance from the display name /
first-name + last-initial of the legal name; the trader may set a preferred
public display name (profile setting). Legal identity stays separate from public
display identity (prior milestone principle).

## 2. Public verification

`/verify/:token` (public, unauthenticated web route + `GET
/api/v1/verify/:token` public API). Returns ONLY: `VERIFIED HAPPY TRADER
CERTIFICATE`, public display name, type, amount (where applicable), issued
month/year, `certificate_public_id`, and status. **Never** exposes legal name /
email / phone / KYC / internal account or risk data / private ids. A revoked or
unknown token shows an explicit invalid/revoked state. QR-compatible URL.

Rate-limited; no enumeration signal beyond valid/invalid (tokens are random).

## 3. Achievements

### 3.1 Data model — `achievements` (net-new)

| Column | Notes |
| --- | --- |
| `id` uuid PK | |
| `organization_id` / `customer_identity_id` | |
| `type` | `FUNDED｜FIRST_PAYOUT｜PAID_5K｜PAID_10K｜PAID_25K｜FIVE_PAYOUT_CLUB｜ACCOUNT_COMPLETED` |
| `dedupe_key` | unique per (identity, milestone) — exactly-once |
| `is_public` | trader visibility toggle (default false) |
| `earned_at` | |
| `meta` | jsonb (e.g. cumulative amount) |

Unique `(organization_id, dedupe_key)`. Restrained: **no XP, no loot, no casino
animations, no economy.**

### 3.2 Issuance

A deferred subscriber issues achievements on the same authoritative events
(`account.funded`, `payout.paid` with running totals, completion). Cumulative
thresholds (PAID_5K/10K/25K) computed from the payout ledger's trader-share total
at each `payout.paid`; each threshold issues once (`onConflictDoNothing`).
Audited + `achievement.issued` event.

### 3.3 Visibility

`Show Achievements Publicly ON/OFF` (per trader) and per-achievement `is_public`
where reasonable. Private financial detail is never exposed without explicit
visibility. Public surfacing (if any) shows only the badge, never amounts unless
the trader opted in.

## 4. Testing

Unit (visibility/privacy rules, threshold math, public-verification projection
excludes sensitive fields), invariant (certificate/achievement issue exactly once
per triggering event), DB/concurrency (duplicate payout-paid → one payout
certificate + at-most-one threshold achievement), HTTP/authz (public verify
exposes only allowed data; a trader cannot read another's private certificate
data; achievements respect visibility). Browser: certificates render, public
verification works, achievements privacy toggle works.
