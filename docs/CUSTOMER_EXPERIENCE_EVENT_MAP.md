# Customer Experience Event Map (Experience Layer Phase 2)

Every celebration the canonical `/portal` can show, the AUTHORITATIVE event that triggers
it, its intensity, how acknowledgement is persisted, and where its actions lead. There is
**one** celebration system (`ExperienceCelebration` / `CelebrationHost`,
`apps/web/src/portal/v2/experience-celebration.tsx`) driven **only** by the server feed
`GET /api/v1/portal/celebrations` (`apps/server/src/platform/celebrations.ts`). Nothing is
hardcoded per page; nothing fires from client state.

## Trigger source

A celebration is derived from an **achievement row** (`achievements` table) — issued
exactly once per `(organizationId, dedupeKey)` on an authoritative domain event by the
server's deferred subscribers. The experience layer never issues achievements; it reads
them. The matching **certificate** and **account** are attached for the moment's actions,
but the achievement is the trigger.

- Stable key: `eventKey = achievement:<achievementId>`.
- Owner scope: resolved from the caller's `customer_identity_id`; a customer can only ever
  see their own events (proven in `celebrations.test.ts`).

## Acknowledgement (idempotency — §23)

- Table: `celebration_acks (customer_identity_id, event_key)` — UNIQUE, migration `0038`.
- On dismiss, the client calls `POST /api/v1/portal/celebrations/ack { eventKey }`.
- `listPendingCelebrations` filters out acknowledged keys, so a moment is shown **once** and
  never replays on refresh, re-login, or another device.
- A malformed/foreign `eventKey` is a quiet no-op (regex-bounded, owner-scoped).

## Event table

| Event (achievement type) | Authoritative source | Celebration kind | Intensity | Priority | Ack persistence | Primary actions |
|---|---|---|---|---|---|---|
| `HUNDREDK_CLUB` | `achievements` ← cumulative PAID trader-share ≥ $100k | CLUB | HIGH | 100 | `celebration_acks` | View certificate · (plaque is manual) |
| `ACCOUNT_COMPLETED` | `achievements` ← account reached max payouts | ACCOUNT_COMPLETED | HIGH | 90 | `celebration_acks` | View account · View certificate |
| `FIRST_PAYOUT` | `achievements` ← first `payout_requests.state=PAID` | PAYOUT | HIGH | 80 | `celebration_acks` | View account · View certificate |
| `FUNDED` | `achievements` ← `account_qualifications.fundingState=FUNDED` | FUNDED | HIGH | 70 | `celebration_acks` | View funded account · View certificate |
| `FIFTYK_CLUB` | `achievements` ← PAID trader-share ≥ $50k | CLUB | MAJOR | 60 | `celebration_acks` | View certificate |
| `TENK_CLUB` | `achievements` ← PAID trader-share ≥ $10k | CLUB | MEDIUM | 50 | `celebration_acks` | View certificate |
| `FIVE_PAYOUT_CLUB` | `achievements` ← five PAID payouts | MILESTONE | MEDIUM | 40 | `celebration_acks` | — |
| `PAID_25K` / `PAID_10K` / `PAID_5K` | `achievements` ← cumulative PAID trader-share thresholds | PAYOUT | MEDIUM | 35/30/25 | `celebration_acks` | — |

Priority is the §76 order. When several are unseen, the highest-priority fires and the card
shows a compact "you also earned N more" line; each is acknowledged as it is dismissed.

## Goal completion (not in the modal queue)

Personal-goal completion (§27) is a **small** interaction, handled inline on the Progress
page: an optimistic checkbox that persists via `POST /goals/:id/complete`, with a brief rose
pop and rollback on failure. It is deliberately NOT a full-screen celebration. TRACKED goals
cannot be completed by hand (`TRACKED_AUTO_ONLY`) — they complete only from authoritative
data.

## What is deliberately NOT celebrated (§28)

Number of trades, position size, trading more, recovering losses, reset purchases, blown
accounts, near-breach recovery, revenge trading, activity streaks. The only celebration
sources are verified accomplishments: funded status, payouts, clubs, account completion,
certificates, and personal goals.

## Reduced motion / performance

The celebration canvas is a lightweight Canvas-2D burst (capped particle count by intensity),
disposed on unmount (no RAF/listener leak), and skipped entirely under
`prefers-reduced-motion` — the card still appears with full information. The modal is
skippable (Esc / dismiss) and non-blocking after dismissal.
