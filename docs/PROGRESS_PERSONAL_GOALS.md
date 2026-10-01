# Progress — Personal Goals

Customer-authored goals on the Happy Trader journey. Authoritative server records owned by
`customerIdentityId` — never localStorage, never cross-customer.

## Record (`personal_goals`, migration 0037)

`id, organizationId, customerIdentityId, title(120), note(600), kind(16), metric(32),
targetValue(bigint), status(16) default ACTIVE, pinned bool, completedAt, archivedAt,
createdAt, updatedAt`. Indexes on `customerIdentityId` and `(customerIdentityId, status)`.

Money targets are bigint micro-dollars (no float).

## Kinds

- **MANUAL** — a personal aim the customer marks done themselves (`completePersonalGoal`).
- **TRACKED** — bound to an authoritative metric; completes **automatically**.

### Tracked metrics (progress/accomplishment only — never trading activity)

| Metric | Source | Target unit |
|---|---|---|
| `CUMULATIVE_PAYOUT_MICROS` | `cumulativeTraderShareMicros` (PAID) | micros |
| `FUNDED_ACCOUNTS` | count funded qualifications | count |
| `EVALUATIONS_PASSED` | count qualification rows | count |

Deliberately NOT expressible: number of trades, streaks, contracts, risk taken. This is
the anti-gamification boundary.

## Forge protection

- A TRACKED goal can **never** be completed by request: `completePersonalGoal` throws
  `TRACKED_AUTO_ONLY` for non-MANUAL goals.
- Tracked completion happens only in `reconcilePersonalGoals`, which reads the same
  authoritative aggregates that drive payouts, guarded by `UPDATE ... WHERE status='ACTIVE'`
  (idempotent, exactly-once).
- `kind`/`metric` are immutable after creation (can't be re-pointed to dodge a target).
- Every mutation is loaded through `ownedGoal(userId, goalId)` → cross-customer access is
  `NOT_FOUND`.

## API (`/api/v1/portal`)

- `GET /progress` — full journey view (reconciles tracked goals first)
- `GET /goals` — caller's goals
- `POST /goals` — create (MANUAL or TRACKED)
- `PATCH /goals/:id` — edit title/note/target/pin (status not editable here)
- `POST /goals/:id/complete` — MANUAL only
- `DELETE /goals/:id` — archive (soft delete)

## Current focus

Customers pin 1–3 ACTIVE goals; the pin ceiling (`MAX_PINNED_GOALS = 3`) is enforced
server-side in `createPersonalGoal`/`updatePersonalGoal`.

## Tests

`apps/server/src/platform/personal-goals.test.ts` — manual complete, forge refusal,
tracked auto-complete at exact boundary, unpaid-excluded, club boundaries, zero-state,
cross-customer isolation, pin ceiling.
