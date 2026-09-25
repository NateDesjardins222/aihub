# 07 — Remediation & money safety

This is the heart of the milestone's safety model. Support **requests** a
remediation; a *different* authorized actor **approves** it; and only then does the
**canonical domain service** execute it. Support code has no direct write path to
money, balances, executions, P&L, payouts, commissions or refund state. Every step
is idempotent and audited, and a failure carries the real reason — nothing is faked
green. The engine is `support-remediation.ts`.

## Remediation types

`REMEDIATION_TYPES`: `COURTESY_RESET`, `TECHNICAL_RESET`, `ACCOUNT_ADJUSTMENT`,
`TRADING_REMEDIATION`, `REFUND`, `PURCHASE_CORRECTION`, `PAYOUT_CORRECTION`,
`CERTIFICATE_CORRECTION`, `ACCESS_RESTORATION`, `OTHER`.

## Status machine

`REMEDIATION_STATUSES`: `REQUESTED` → `UNDER_REVIEW` → `APPROVED` → `EXECUTING` →
`EXECUTED`, with `DENIED` and `FAILED` as off-ramps.

## 1. Request — `requestRemediation`

Records a `support_remediations` row (`REM-XXXXXX`) with `type`, `reason`,
`detail`, optional `amount_micros`, and the requesting staff id. Guards:

- a reason is required; a staff identity is required;
- `amount_micros`, when given, must be a positive integer (micros);
- an `idempotency_key` makes a repeat request return the existing row.

The row starts `REQUESTED`. Requesting does not move any money. Routes:
`POST /support/tickets/:id/remediations` — `support.remediation.request` for most
types, `support.refund.request` for a `REFUND` (enforced per-type in the handler).

## 2. Approve — four-eyes, in `approveRemediation`

Runs in a transaction under a per-remediation advisory lock (lock class `'SRMD'`):

- idempotent — a second approve of an already-`APPROVED` row is a no-op;
- only a `REQUESTED`/`UNDER_REVIEW` row is approvable;
- **four-eyes:** the approver must not be the requester
  (`A remediation must be approved by someone other than the requester.`).

On success it stamps `approved_by_user_id`/`approved_at`, bumps `version`, and
audits. `denyRemediation` moves an unexecuted row to `DENIED` with a reason.
Approve/deny/execute routes all require `support.remediation.approve` or
`support.refund.approve` (see the role gate in doc 11).

## 3. Execute — atomic claim, exactly-once, in `executeRemediation`

First, inside a locked transaction, it **claims** the row by moving
`APPROVED → EXECUTING` — so only one worker proceeds. If the row is already
`EXECUTED` it returns the recorded result (idempotent, no re-execution). Then it
dispatches by type to the canonical service:

| Type | Canonical service called | `execution_ref` |
| --- | --- | --- |
| `ACCOUNT_ADJUSTMENT` | `applyAdminAdjustment` (credit/debit, reason code, links the ticket's incident) | `adjustment:<id>` |
| `COURTESY_RESET` / `TECHNICAL_RESET` | `createResetOrder` for the failed account + ticket customer | `reset_order:<id>` |
| `REFUND` | `refundEligibility` check (unless `detail.exception === true`), then `handleRefund` on the commercial order | `refund:<orderId>:INTERNAL_RECORDED` |
| `TRADING_REMEDIATION`, `PURCHASE_CORRECTION`, `PAYOUT_CORRECTION`, `CERTIFICATE_CORRECTION`, `ACCESS_RESTORATION`, `OTHER` | none auto-executed | `MANUAL_ACTION_REQUIRED` |

Key details:

- **Account adjustment** requires an `accountId` and a positive `amount_micros`;
  the money actually moves through `applyAdminAdjustment`, which carries its own
  authorization and audit.
- **Refund** runs the ordinary `refundEligibility` check *unless* the request is
  explicitly marked `detail.exception === true` (a duplicate-charge or
  technical-issue refund). `handleRefund` records the **internal** refund state;
  the `execution_ref` ends `INTERNAL_RECORDED` precisely because any **external**
  settlement (returning funds on the payment rail) is a separate provider/manual
  step and is **never faked** here.
- **Controlled types with no safe automatic executor** are recorded and approved
  but resolve to `MANUAL_ACTION_REQUIRED`: the sensitive action is then performed
  by the authorized role in its own console. The remediation still captures the
  approval and audit trail.

On success it stamps `EXECUTED`, `executed_at`, the `execution_ref`, and audits.
On **any** engine failure it records `FAILED` with the real `failure_reason` (e.g.
`ordinary refund not eligible: TRADE_EXECUTED`) and audits — the operator sees the
truth, not a green checkmark.

## Money is always micros

`amount_micros` is a `bigint`; the request validates it is a positive integer. No
floating-point money is ever accepted or computed.

## Role split — request vs approve

- **SUPPORT** (front line) can *request* remediation and refunds
  (`support.remediation.request`, `support.refund.request`) but holds **neither**
  approval permission.
- **ADMIN** (and owner) holds `support.remediation.approve` /
  `support.refund.approve`, plus `support.config.manage` and
  `support.templates.manage`.

Combined with the four-eyes rule in `approveRemediation`, this means a single
person can never both request and approve a money action, and the front line can
never approve one at all. The integrity check `INV_REMEDIATION_FOUR_EYES` (doc 12)
continuously verifies that every `EXECUTED`/`EXECUTING` remediation has an approver
who is not the requester.
