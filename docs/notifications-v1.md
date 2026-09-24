# Notifications — Email & SMS, V1

Authoritative domain events become customer emails and texts — **asynchronously,
idempotently, and never on the critical path.** Trading, payment, and provisioning
never wait for a notification provider; a funded account exists whether or not the
email ever sends.

> **No real provider is connected.** No Resend, no Twilio credentials are wired.
> `MockEmailProvider`/`MockSmsProvider` are the working default and record what
> *would* have been sent; the Resend/Twilio adapters are seams that report
> `unconfigured`. A delivered mock notification is **not** evidence a real email
> or SMS was sent.

This document is the contract for checkpoint I.

---

## 1. The one rule that shapes everything

> **TRADING / PAYMENT / PROVISIONING MUST NEVER WAIT FOR RESEND OR TWILIO.**

So notifications are strictly downstream of the authoritative transaction:

```
authoritative service (commit)
   └─ domain event  (events.publish — row written first)  ← already the pattern
        └─ notification worker (separate, async)
             └─ EmailProvider / SmsProvider (Mock | Resend | Twilio)
```

The producing services (identity, commerce, provisioning, funding, payouts)
already `events.publish` inside their transaction — the row is written before
subscribers run, and subscribers are bystanders (`events.ts:89-107`). The
notification system attaches **here**, exactly as `events.ts` intends
("Payments, e-mail, … attach HERE later, by subscribing or by draining the
outbox — never by a call inside the matcher"). It never reaches back into a
domain transaction. If email is down, the funded account still exists; the
notification is retried separately.

---

## 2. What is reused

| Concern | Source |
| --- | --- |
| Event bus + `domain_events` row | `events.ts` |
| Outbox (durable hand-off) | `outbox.ts` `enqueueOutbox`, `outbox_events`, delivery worker |
| Audit | `audit.ts` (`AuditSubject` gains `NOTIFICATION`) |
| Verified contacts (recipient addresses) | `verified_contacts` (customer-identity doc) |
| Tenancy / actor | `organizationId`, `actor.ts` |

Net-new: `notification_messages` table, `platform/notifications.ts` (the service),
the `EmailProvider`/`SmsProvider` interfaces + Mock/Resend/Twilio adapters, and a
notification worker that consumes events → messages → providers.

Note: `account-notify.ts` is Postgres LISTEN/NOTIFY plumbing for cross-process
account-change wakeups — **not** a customer notification system. It is unrelated
and untouched.

---

## 3. Data model — `notification_messages`

One row per **logical** notification (a type + recipient + a keyed event), so a
retried event never sends "FUNDED READY" seventeen times.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `customer_identity_id` | uuid FK, nullable | the recipient identity |
| `type` | varchar(40) | one of the ~19 notification types (§5) |
| `channel` | varchar(8) | `EMAIL｜SMS` |
| `recipient` | varchar(254) | resolved address/number at send time |
| `template_version` | varchar(24) | which template rendered it |
| `dedupe_key` | varchar(200) | **the idempotency key** (§6) |
| `status` | varchar(16) | `PENDING｜SENT｜FAILED｜SUPPRESSED` |
| `terminal` | boolean | true once `SENT` or permanently `FAILED`/`SUPPRESSED` |
| `attempts` | integer default 0 | |
| `max_attempts` | integer default 6 | |
| `provider` | varchar(16), nullable | `MOCK｜RESEND｜TWILIO` |
| `provider_ref` | varchar(200), nullable | provider message id |
| `last_error` | varchar(200), nullable | coarse, no secrets |
| `payload` | jsonb | rendered subject/body refs + template data (no secrets/codes beyond what the message must carry) |
| `created_at` / `updated_at` / `sent_at` | timestamptz | |

Unique: `(organization_id, dedupe_key)` — the structural at-most-once guard.
Index: `(status, channel)`, `(customer_identity_id)`.

---

## 4. Provider boundaries

```ts
export interface EmailProvider {
  readonly name: 'MOCK' | 'RESEND';
  isConfigured(): boolean;
  send(msg: OutboundEmail): Promise<ProviderSendResult>;
}
export interface SmsProvider {
  readonly name: 'MOCK' | 'TWILIO';
  isConfigured(): boolean;
  send(msg: OutboundSms): Promise<ProviderSendResult>;
}
type ProviderSendResult =
  | { ok: true; providerRef: string }
  | { ok: false; retryable: boolean; error: string };
```

- **`MockEmailProvider` / `MockSmsProvider`** (working default): `isConfigured()`
  → true; `send` records the message to an in-memory + DB sink and returns
  `{ ok:true, providerRef:'mock_…' }`. The owner console and tests read this sink
  to prove a notification "was delivered" (to the mock). Deterministic.
- **`ResendEmailProvider`** seam: `isConfigured()` = `Boolean(env.RESEND_API_KEY)`;
  when unconfigured, `send` returns `{ ok:false, retryable:false, error:
  'RESEND_UNCONFIGURED' }` and the message goes `SUPPRESSED` (not a silent
  success). No live call this milestone.
- **`TwilioSmsProvider`** seam: `isConfigured()` = `Boolean(env.TWILIO_ACCOUNT_SID
  && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM)`; same unconfigured behaviour.
- Selection: `emailProviderFromEnv()` / `smsProviderFromEnv()` prefer the real
  adapter when configured, else Mock; surfaced to the owner as
  `email: 'mock'|'resend'`, `sms: 'mock'|'twilio'`. **Mock is displayed as mock,
  never as "production delivering".**

---

## 5. Notification types (~19) and channel policy

| # | Type | Channels | Trigger event |
| --- | --- | --- | --- |
| 1 | `WELCOME` | EMAIL | `customer_identity.created` |
| 2 | `VERIFY_EMAIL` | EMAIL | `contact.challenge_started` (EMAIL) |
| 3 | `VERIFY_PHONE` | SMS | `contact.challenge_started` (SMS) |
| 4 | `IDENTITY_STARTED` | EMAIL | `identity.verification_started` |
| 5 | `IDENTITY_VERIFIED` | EMAIL | `identity.verified` |
| 6 | `IDENTITY_ACTION_REQUIRED` | EMAIL + SMS | `identity.step_up_required` / `identity.under_review` |
| 7 | `PURCHASE_CONFIRMED` | EMAIL | `entitlement.provisioned` (or `commerce.event_received` PAYMENT) |
| 8 | `EVAL_READY` | EMAIL | `entitlement.provisioned` (account active) |
| 9 | `EVAL_PASSED` | EMAIL | `evaluation.qualified` |
| 10 | `FUNDED_READY` | EMAIL + SMS | `account.funded` |
| 11 | `PAYOUT_ELIGIBLE` | EMAIL | `payout.eligibility_unlocked` |
| 12 | `PAYOUT_REQUESTED` | EMAIL | `payout.requested` |
| 13 | `PAYOUT_APPROVED` | EMAIL + SMS | `payout.approved` |
| 14 | `PAYOUT_PAID` | EMAIL + SMS | `payout.paid` |
| 15 | `REFUND` | EMAIL | `commerce.refunded` |
| 16 | `DISPUTE_ACTION` | EMAIL | `commerce.dispute_opened` |
| 17 | `SECURITY_LOGIN` | EMAIL (+ SMS urgent) | new-device login event |
| 18 | `PASSWORD_CHANGED` | EMAIL | password change |
| 19 | `ACCOUNT_RESTORED` | EMAIL | hold released / account restored |

**SMS is reserved** for verification, major milestones (funded), payout
approved/paid, and security/urgent — never routine confirmations. The mapping is
data (`type → channels[]`), so policy is one table, not scattered `if`s.

---

## 6. Idempotency — the dedupe key

`dedupe_key = <type>:<channel>:<identityId>:<subjectKey>:<templateVersion>` where
`subjectKey` is the stable id of the thing that happened (e.g. the qualification
id for `EVAL_PASSED`, the funded account id for `FUNDED_READY`, the challenge id
for `VERIFY_EMAIL`, the order id for `PURCHASE_CONFIRMED`).

- The worker inserts `notification_messages` with `onConflictDoNothing` on
  `(organization_id, dedupe_key)` **before** contacting any provider. A duplicate
  event → the insert no-ops → nothing is sent twice. This is the "not 17 FUNDED
  READY" guarantee, structurally.
- Only a `PENDING`, non-`terminal`, under-`max_attempts` row is picked up for
  sending. A `SENT` row is terminal; a permanently failed row is terminal
  (`FAILED`); an unconfigured provider yields `SUPPRESSED` (terminal, visible).
- Retryable provider failures increment `attempts` with backoff and stay
  `PENDING`; exceeding `max_attempts` → terminal `FAILED`, surfaced as an owner
  **Notification Failure** exception.

---

## 7. The worker

- **Consumption:** an in-process subscriber on `events.publish` maps a domain
  event → zero or more intended notifications (via §5's table), resolves the
  recipient from `verified_contacts` (primary of the channel), computes the
  `dedupe_key`, and inserts the `notification_messages` row(s) (`onConflictDoNothing`).
  This subscriber does **no** provider I/O — it only records intent, so it is
  fast and cannot delay the event.
- **Delivery:** a separate loop (and a startup drain) selects `PENDING`,
  non-terminal messages, renders the template, calls the provider, and records the
  result under a per-message guard (`SELECT … FOR UPDATE` on the message row, so
  two workers never double-send). Backoff on retryable failures.
- **Durability:** the intent row is in the DB before any send; a crash loses no
  notification (the drain re-picks `PENDING`). The producing transaction already
  committed regardless — the account/payment is safe.

The worker is registered next to `registerAutoCertification`/`registerAutoFunding`
in `app.ts`, and is guarded so its failures never propagate to the event
publisher.

---

## 8. Security & privacy

- **No secrets, codes, or PII beyond necessity in logs.** `last_error` is coarse;
  provider payloads are not stored raw. A verification code lives only in the
  rendered message body of that one `VERIFY_*` message (which is the point of it)
  and is never logged separately.
- **Tenancy:** every row and query is org-scoped; a recipient is resolved from the
  identity's own verified contacts, so a notification cannot be addressed
  cross-tenant.
- **RBAC:** SUPPORT reads notification history; ADMIN can **resend** a
  notification (a *new* message with a fresh manual dedupe suffix, reason +
  audit); no role edits provider secrets.
- **Suppression is honest:** an unconfigured provider produces a visible
  `SUPPRESSED` message, never a fake `SENT`.

---

## 9. Owner operations (console, checkpoint J)

Per customer identity: a **Notifications** tab showing every message (type,
channel, status, attempts, provider, provider_ref, timestamps). An
`email/sms: mock|resend|twilio` health line makes the active provider explicit.
Controlled action: **resend** (RBAC + reason + audit). Exception queue:
**Notification Failure** (terminal `FAILED`, and `SUPPRESSED` where a real
provider was expected).

---

## 10. Observability

Metrics/counters: notifications intended, sent, suppressed, failed, retried, per
type and channel; delivery latency (event → sent). Never logs raw codes,
secrets, or full provider payloads.

---

## 11. Browser acceptance plan (this doc's slice of section 40)

Against the mock providers:

1. Complete the onboarding + purchase + pass→funded flow (other docs).
2. Assert the **PURCHASE_CONFIRMED / EVAL_READY** message appears in the
   customer's notification history (mock-delivered).
3. Assert the **FUNDED_READY** message appears exactly once after the auto-funded
   transition.
4. Re-fire the funded event → **no** second `FUNDED_READY` (dedupe key).
5. Owner Notifications tab shows the lifecycle messages with `provider: mock`.
6. Provisioning/funding succeeded **without** waiting on any provider (proven by
   the flow completing with the mock provider forced to a delayed/failed send in
   a unit/integration test).

Screenshots + JSON artifact via `createReport`.

---

## 12. Explicitly not built (this doc)

Real Resend/Twilio sends, push/FCM, in-app notification center beyond history,
marketing/broadcast campaigns, unsubscribe/preference management beyond
channel-policy defaults, delivery-receipt webhooks from providers. All are seams;
the mock is the working default and is never presented as live delivery.
