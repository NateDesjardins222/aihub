# Progress & Achievements — Existing System Audit

Experience Layer Phase 1. REUSE BEFORE REBUILD. This records what already existed
before building the Progress surface and how each piece was classified.

## Classification

| System | Where | Classification | Notes |
|---|---|---|---|
| `achievements` table | `apps/server/src/db/schema.ts` | **REUSE** | `(organizationId, dedupeKey)` unique → exactly-once; `customerIdentityId` ownership spine. Unchanged. |
| Achievement domain | `apps/server/src/platform/achievements.ts` | **REUSE** | `issueAchievement` (onConflictDoNothing), `cumulativeTraderShareMicros`, `CLUB_MILESTONES`, `listAchievementsForUser`. Unchanged. |
| Recognition subscriber | `apps/server/src/platform/recognition.ts` | **EXTEND** | Deferred, idempotent bystander on `evaluation.qualified / account.funded / payout.paid / account.completed`. Extended only to call `reconcilePersonalGoals` after metric-affecting events. No achievement logic changed. |
| Club milestones | `achievements.ts` `CLUB_MILESTONES` | **REUSE** | `TENK/FIFTYK/HUNDREDK` at 10k/50k/100k × M, physical flag on 100K. Clubs page reads these. |
| Lifetime PAID trader-share | `cumulativeTraderShareMicros(db,userId)` | **REUSE** | `sum(payout_requests.trader_share_micros) where state='PAID'`. Single source for clubs + tracked payout goals. |
| Evaluations passed / funded | `account_qualifications` (+ `accounts`) | **CONNECT** | Count of qualification rows = evaluations passed; `funding_state='FUNDED'` = funded accounts. |
| Member since | `customer_identities.created_at` | **CONNECT** | Natural membership date. |
| Portal achievements API | `GET/PATCH /api/v1/portal/achievements*` | **REUSE** | Existing endpoints untouched. |
| Events / outbox | `apps/server/src/platform/events.ts` | **REUSE** | Publish-then-subscribe; the reconcile hook rides the existing deferred subscriber. |
| Web `Achievement`/`AchievementsView` | `apps/web/src/portal/lib.tsx` | **REUSE** | Types reused; Progress page adds its own `ProgressView`/`GoalView`. |
| Portal V2 nav/route | `Shell.tsx` / `Review.tsx` | **EXTEND** | Added `progress` destination between Certificates and Billing. |
| Personal goals | — | **NEW** | No prior goal concept existed (`schema.ts` had zero `goal` matches). New table + domain + routes. |
| Outbox delivery worker | `events.ts` `pendingEvents/markDelivered` | **DEFER** | Generic worker remains future work; read-time + event-time reconcile is sufficient now. |

## What was NOT rebuilt

Achievements, certificates, clubs, payout accounting, customer identity, and the
recognition subscriber are all pre-existing and were reused as-is. The only new
authoritative write surface is `personal_goals`.
