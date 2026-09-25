# Owner OS — Account Operations & Adjustments

Module: `account-ops.ts`
Routes: `/api/v1/admin/ops/accounts/:id/preview | /adjust | /pause | /resume |
/disable | /enable`, `/accounts/:id/adjustments`, `/provisioning/...`

## No raw balance edit — ever

There is no mutable balance field. A financial correction is an **append-only**
`admin_adjustments` row (`applyAdminAdjustment`) with:

- an explicit **reason code** from a closed vocabulary (`ADJUSTMENT_REASON_CODES`),
- a required human explanation,
- a positive amount for CREDIT/DEBIT (METADATA adjustments carry no amount and do
  not move the observed net),
- an audit event for every adjustment.

`adjustmentNetMicros(db, accountId)` derives the net effect by summing the ledger.
The `admin_adjustments` table has a DB trigger that **refuses UPDATE and DELETE**:
history is immutable. Applying an adjustment requires `accounts.adjust` (owner-only)
**and** a `FINANCIAL` step-up.

## Preview before you act

`previewAction(db, accountId, action)` reports what an action *would* do without
mutating:

- **pause** — preserves risk-reducing actions, never touches balance.
- **reset** — reports payment/preservation implications, or a truthful block for a
  live account, and never throws.
- unknown actions are rejected.

## Lifecycle wrappers (no balance mutation)

- `pause` / `resume` — set/clear the operator hold; a reason is required to pause.
  Requires `accounts.pause`.
- `disable` — requires `accounts.pause` **and** a `FINANCIAL` step-up.
- `enable` — clears a disable.

All wrappers write audit events and consume server-authoritative rules; none of
them edits a balance directly.

## Reset four-eyes

An account reset is a **request** (`accounts.reset.request`, held by SUPPORT) and a
separate **approve** (`accounts.reset.approve`, owner-only). The requester and the
approver are distinct permissions by design.

## Provisioning exceptions

Paid purchases that failed to provision surface as a queue
(`provisioningExceptionQueue`) and can be retried with
`accounts.provisioning.retry`. The retry is idempotent.
