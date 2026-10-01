# Progress — Achievement & Club Model

## Achievements (reused)

Table `achievements`: `id, organizationId, customerIdentityId, type(32), dedupeKey(200),
isPublic, meta jsonb, earnedAt, createdAt`. Unique `(organizationId, dedupeKey)` makes
every unlock **exactly-once**; `issueAchievement` uses `onConflictDoNothing` so replays
and duplicate events converge and never unlock twice.

Types (`AchievementType`): `FUNDED, FIRST_PAYOUT, PAID_5K, PAID_10K, PAID_25K,
FIVE_PAYOUT_CLUB, ACCOUNT_COMPLETED, TENK_CLUB, FIFTYK_CLUB, HUNDREDK_CLUB`.

Derivation is event-driven in `recognition.ts` (deferred, idempotent, replay-safe,
auditable) — never computed in React.

## Clubs (reused definition, surfaced new)

`CLUB_MILESTONES` in `achievements.ts`:

| Club | Threshold | Visual | Physical |
|---|---|---|---|
| `TENK_CLUB` | cumulative PAID trader-share ≥ $10,000.00 | silver/champagne | no |
| `FIFTYK_CLUB` | ≥ $50,000.00 | rose-champagne | no |
| `HUNDREDK_CLUB` | ≥ $100,000.00 | gold/chrome | yes (plaque, manual fulfillment) |

**Club input is cumulative PAID trader-share only** — `cumulativeTraderShareMicros` =
`sum(payout_requests.trader_share_micros) WHERE state='PAID'`. NOT simulated P&L, account
size, gross/requested payout, approved-but-unpaid, or temporary balance.

### Boundary semantics

`achieved = lifetimePaidTraderShareMicros >= thresholdMicros` (inclusive). Tested at
$9,999.99 (not in), $10,000.00 (in), and $50k/$100k equivalents in
`personal-goals.test.ts`.

## Progress read model

`progress.ts > progressForUser(db, userId)` assembles (read-only, idempotent):

- `memberSinceMs` ← `customer_identities.created_at`
- `hero`: lifetime paid, funded accounts, evaluations passed, achievements earned,
  current club (highest achieved), next club (first un-achieved + remaining micros)
- `clubs[]`: each club with `achieved`, `achievedAt` (from the club achievement row)
- `milestones[]`: the authoritative achievement rows (newest first) — the timeline source
- `goals[]`: personal goals (reconciled first)

## Milestone labels

Display names live in `apps/web/src/portal/v2/progress-page.tsx` (`MILESTONE_LABEL`,
`CLUB_LABEL`) — presentation only; keys/thresholds/truth stay server-side.
