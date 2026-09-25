# 13 — Runbooks

Operational procedures for the support team. Two rules apply to every one of them:

- **Never mutate money, balances, executions, payouts, commissions or refund state
  directly.** Use a remediation, which routes to the canonical service and requires
  a separate approver.
- **Never disclose internal notes or another customer's data.** Internal notes,
  internal attachments and staff identities never reach a customer.

Endpoints below are under `/api/v1/admin/ops` for staff and `/api/v1/support` for
customers. Every staff action is permission-gated and audited.

---

## (a) Customer reports a wrong or late payout

**Trigger:** a customer says a payout is late, missing, or the wrong amount.
**Authorized:** `support.read`, `support.respond`; escalation needs
`support.escalate`.

1. Open the ticket workspace (`GET /support/tickets/:id`). Link the payout if not
   already linked (`POST /support/tickets/:id/link`, `objectType: payout`).
2. Run diagnostics: `GET /support/diagnostics?objectType=payout&objectId=...`. Read
   the state-machine state, eligibility state, withdrawable amount, qualifying days,
   consistency ratio, and any enforcement hold. These are the recorded facts.
3. Check the investigation timeline (`GET /support/tickets/:id/timeline`) for the
   payout's lifecycle events.
4. If the facts explain it (e.g. eligibility not met, enforcement hold), reply and
   resolve with `EXPLANATION_ONLY` or `CUSTOMER_EDUCATION`.
5. If the payout looks genuinely wrong, escalate to `PAYOUT_OPERATIONS`
   (`POST /support/tickets/:id/escalate`). A payout correction is a
   `PAYOUT_CORRECTION` remediation → it resolves to `MANUAL_ACTION_REQUIRED`; the
   payout operator performs the actual correction in the payout console.

**Do not** adjust the payout or its amount from support.

---

## (b) Customer requests a refund

**Trigger:** a customer asks for their purchase to be refunded.
**Authorized:** `support.refund.request` to request; `support.refund.approve`
(admin) to approve.

1. Link the purchase (`objectType: purchase`) and check ordinary eligibility:
   `GET /support/refund-eligibility?orderId=...`.
2. **Ordinary refund** (eligible → `NO_ACCOUNT_PROVISIONED` or `NO_TRADE_EXECUTED`):
   request a `REFUND` remediation (`POST /support/tickets/:id/remediations`,
   `type: REFUND`, `detail.orderId`). Do **not** set `exception`.
3. **Not eligible** because the account traded (`TRADE_EXECUTED`): an ordinary
   refund is blocked by design. If it is a genuine billing error, treat it as an
   exception (below); otherwise explain and resolve.
4. **Duplicate charge or platform/technical issue:** request a `REFUND` remediation
   with `detail.exception = true` — this bypasses the ordinary trade check on
   purpose (never fake the eligibility result). Reserve this for real duplicate
   charges or platform-caused issues, and say why in the reason.
5. An admin approves (four-eyes: not the requester) and executes. Execution records
   the **internal** refund state; the **external** settlement on the payment rail
   is a separate step and is never faked. Confirm settlement out-of-band before
   telling the customer the money is back.

**Do not** approve your own refund request; **do not** claim external settlement
that hasn't happened.

---

## (c) Resolving a duplicate charge

**Trigger:** two charges for one intended purchase.
**Authorized:** `support.refund.request` + admin `support.refund.approve`.

1. Link both purchases; use diagnostics to confirm the duplicate (same customer,
   same product, near-identical timing, one redundant).
2. Request a `REFUND` remediation on the **duplicate** order with
   `detail.exception = true` and a reason naming it a duplicate charge.
3. Admin approves and executes; verify the external settlement.
4. Resolve with resolution code `REMEDIATION_COMPLETED` and root cause
   `BILLING_ERROR`.

**Do not** refund the order that actually provisioned the account the customer is
using.

---

## (d) Escalating a suspected account-failure dispute

**Trigger:** a customer disputes an account failure/breach.
**Authorized:** `support.read`, `support.escalate`.

1. Link the account (`objectType: account`) and run diagnostics: read status, rule
   status, drawdown band/floor/headroom, and any `MAX_LOSS_BREACH` reason code.
2. Review the timeline for the events around the breach.
3. Categorise under `ACCOUNT_FAILURE` and escalate to `RISK_ENFORCEMENT`
   (`POST /support/tickets/:id/escalate`) with an internal note summarising the
   findings.
4. Enforcement reviews via its own console. If a courtesy/technical reset is later
   warranted, it goes through a `COURTESY_RESET` / `TECHNICAL_RESET` remediation
   (canonical `createResetOrder`), not a manual account edit.

**Do not** reverse a breach or reset an account directly from support.

---

## (e) Approving and executing a remediation (four-eyes)

**Trigger:** a remediation is `REQUESTED`.
**Authorized:** `support.remediation.approve` or `support.refund.approve` (admin),
and you must **not** be the requester.

1. Review the remediation (via the ticket workspace) — type, amount (micros),
   reason, and the linked object.
2. Approve: `POST /support/remediations/:remediationId/approve`. The four-eyes
   check refuses if you are the requester. To reject instead, use `/deny` with a
   reason.
3. Execute: `POST /support/remediations/:remediationId/execute`. Execution is a
   one-time atomic claim (`APPROVED → EXECUTING → EXECUTED`); a repeat is a no-op.
4. On failure the remediation goes `FAILED` with the real reason — read it, fix the
   cause (e.g. wrong `accountId`, ineligible order), and request a fresh
   remediation. Do not retry blindly.

**Do not** approve a remediation you requested; **do not** treat a `FAILED` result
as done.

---

## (f) Handling an attachment safely

**Trigger:** a customer or staff member attaches a file.
**Authorized:** upload via `support.respond` (staff); read via
`support.attachments.read`.

1. Uploads are validated automatically (allowed types, size limit, executable and
   script rejection). A rejected file is not stored.
2. Set visibility deliberately: a staff upload defaults to `INTERNAL`; only mark it
   `CUSTOMER` if the customer should see it.
3. Download via the signed, time-limited link only. Staff downloads also require
   `support.attachments.read`; customer downloads require a valid token and
   ownership. Never share a raw storage path.

**Do not** re-share an internal attachment to a customer; **do not** bypass the
signed-download route.

---

## (g) Responding to an SLA breach

**Trigger:** the inbox / Command Center shows tickets past SLA (System Doctor
`support` probe is `WARNING`).
**Authorized:** `support.read`, `support.assign`, `support.respond`.

1. Open the inbox `URGENT` and default views; sort by SLA state (`BREACHED`,
   `DUE_SOON`).
2. Assign unassigned breached tickets (`POST /support/tickets/:id/assign`).
3. Post a public first response — this stamps the SLA first-response time.
4. If you are legitimately waiting on the customer, a provider, or another team,
   move to the matching `WAITING_*` status so the SLA clock pauses honestly. Do not
   use a waiting status just to stop the clock.

**Do not** resolve a ticket without a real customer summary to clear a breach.

---

## (h) Linking a ticket to an incident for mass comms

**Trigger:** several tickets share one platform incident.
**Authorized:** `support.respond` (linking); admin tier for any future
mass-communication surface.

1. Link the incident to each affected ticket:
   `POST /support/tickets/:id/link`, `objectType: incident`, `objectId: <incident
   id>`. The link is the durable association staff use to see impact.
2. When the incident resolves, resolve the tickets with resolution code
   `INCIDENT_RESOLVED` and root cause matching the incident.

> Current limitation: the support routes in this milestone do not provide an
> endpoint to set the ticket's `incident_id` column directly (the inbox can
> *filter* by `incidentId`, and tickets can be *linked* to an incident object as
> above). The `support.mass_notify` permission is reserved for a bulk-communication
> action but is not yet wired to an endpoint — coordinate mass customer comms
> through the existing notification/incident tooling, not a support bulk-send.

**Do not** promise a mass notification the platform cannot yet send from support;
**do not** paste internal incident detail into a customer-visible reply.
