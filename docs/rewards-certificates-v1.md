# Happy Trader Rewards & Certificates (Milestone 6)

Automatic recognition of trader achievements: issue the right certificate exactly
once, render it deterministically from a locked approved master, store it
permanently in the Certificate Vault, make it viewable / downloadable / shareable /
verifiable, and notify the trader — with **no AI image generation anywhere in the
production pipeline**.

## Built on the existing recognition engine

Milestone-1's **Certificates & Achievements V1** already provides the backbone and
M6 extends it rather than duplicating it:

- `certificates` table (immutable records, `verificationToken`, `dedupeKey` unique
  index, `templateVersion`, `publicDisplayName` snapshot, `amountMicros`, `status`).
- `achievements` table (customer-level milestone ledger, `dedupeKey` unique index).
- `recognition.ts` — a deferred bystander subscriber to `evaluation.qualified`,
  `account.funded`, `payout.paid`, `account.completed`; idempotent via
  `onConflictDoNothing` on `(organizationId, dedupeKey)`.
- Public verification at `GET /api/v1/verify/:token` (safe fields only).
- Portal API (`GET /portal/certificates`, `/achievements`, `GET/PATCH /portal/profile`).

M6 adds: **rendered artifacts** (PNG + print-ready PNG + PDF) with a template
manifest system and object storage; the **club milestones** ($10k / $50k / $100k);
the **Certificate Vault** as a first-class portal section; **physical framed
certificate commerce**; the **100K manual plaque**; and the missing
**`account.completed` producer**.

## The approved certificate family

| Type | Trigger (authoritative) | Dynamic fields | Uniqueness |
| --- | --- | --- | --- |
| `FUNDED_TRADER` | `account.funded` (funded lifecycle created/activated) | name, account size, earned date | one per funded account (`funded:<accountId>`) |
| `PAYOUT` | `payout.paid` (PAID state) | name, actual trader payout, paid date | one per paid payout (`payout:<requestId>`) |
| `ACCOUNT_COMPLETED` | `account.completed` (5th payout PAID → COMPLETED) | name, total trader-share paid from that account, completion date | one per account (`complete:<accountId>`) |
| `TENK_CLUB` | lifetime trader-share PAID ≥ $10,000 | name, `$10,000`, earned date | one per customer identity (`tenk_club:<identityId>`) |
| `FIFTYK_CLUB` | lifetime trader-share PAID ≥ $50,000 | name, `$50,000`, earned date | one per customer identity |
| `HUNDREDK_CLUB` | lifetime trader-share PAID ≥ $100,000 | name, `$100,000`, earned date | one per customer identity; **physical plaque, manual fulfillment** |

(The pre-existing `EVALUATION_PASSED` certificate and `PAID_5K/10K/25K` achievement
badges remain untouched; the CLUB certificates are the M6 milestone system with the
locked $10k/$50k/$100k thresholds.)

### Authoritative payout totals

Club milestones use **actual trader-share payouts in final PAID state only**
(`cumulativeTraderShareMicros`, already summing `payout_requests.traderShareMicros`
where `state = 'PAID'`). Never requested/rejected/held/processing/unpaid-approved
payouts, never firm share, never balances, resets, purchases, or refunds. Crossing
is one-way: moving from $9,500 to $11,200 fires the 10K club exactly once (no need
to land on $10,000). The certificate prints the **locked milestone label**
($10,000), not the actual lifetime total; the real total at unlock is stored in
`meta.cumulativeTraderShareMicros` for audit.

## Exactly-once issuance

Every reward is issued inside a transaction with a `dedupeKey` unique index +
`onConflictDoNothing`. Webhook retries, payout retries, lifecycle retries, process
restarts and concurrent workers therefore cannot double-issue. Dedupe keys:
`funded:<accountId>`, `payout:<requestId>`, `complete:<accountId>`,
`{tenk,fiftyk,hundredk}_club:<identityId>`. Frontend state is never used for
deduplication. Concurrent-issuance is tested.

## Certificate display name

The recipient name printed on a certificate comes from the customer-level
`customerIdentities.preferredDisplayName` (the "certificate display name"), falling
back to a safe first-name + last-initial derived from the verified/legal display
name, else "Happy Trader" — never the raw legal name or an email. It is validated
(non-blank, bounded length, no control characters, no markup/script) on the
`PATCH /portal/profile` path. At issuance the exact rendered recipient name is
**snapshotted** into the certificate record (`publicDisplayName`); a later change to
the setting never alters an already-issued certificate. Issued certificates are
immutable.

## Reward delivery & notifications

`reward_delivery` tracks in-app + email delivery per reward. On issuance the
recognition subscriber enqueues a `CERTIFICATE_READY` notification (in-app + email)
through the existing outbox/notifications architecture. Notification failure never
rolls back issuance — delivery retries asynchronously. Emails link to the dashboard
view, not a giant attachment.

## Template versioning

`templateType`, `templateVersion` and `rendererVersion` are frozen on the
certificate at issuance. Changing a design (V1 → V2) never silently re-renders
history; old certificates keep their frozen triple. A deliberate, audited
administrative reissue would create a new artifact/version while preserving the
original record.

## Security

Owner-scoped artifact retrieval, safe-only public verification, unguessable tokens
and storage keys, escaped user text, no IDOR, no owner backdoor that fabricates an
*earned* achievement (any remediation issuance is a separately-audited admin action,
never masquerading as automatic recognition). Detailed in the M6 report.

## What is NOT here

No AI generation, no CSS-drawn certificates, no new artwork invented by code, no
leaderboard/social directory. See `docs/certificate-rendering-architecture.md`,
`docs/certificate-template-manifest.md`, `docs/physical-certificate-commerce-v1.md`,
and `docs/daily-payout-balance-progression.md`.

---

## M6.1 update — approved V1 masters integrated

The five digital certificate types now ship approved Happy Trader Funding **V1
production masters** (`certificate-templates/<type>/v1/`, 1536×1024). Production
issuance renders from these; the non-production `v-test` fixtures are used only
when `NODE_ENV != production`. Dynamic fields render exactly as the artwork
requires: recipient in **uppercase** (immutable snapshot keeps original casing),
FUNDED value as the compact **account size** (`50K`), payout/completed as the
actual paid amount, club types as the **locked** milestone value, and the date as
**`YYYY-MM-DD`** (UTC, from the reward event). See
`docs/production-certificate-assets-v1.md` and
`docs/m6-1-production-certificate-integration-report.md`. The 10K master carries a
baked sample date (its dynamic date field is omitted pending a corrected export);
the 100K club remains a manual plaque.
