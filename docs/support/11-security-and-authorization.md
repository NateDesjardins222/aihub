# 11 — Security & authorization

Support handles other people's money problems, so its authorization model is
deliberately conservative: the front line can investigate and *ask*, but the
sensitive actions — approving money, changing config, mass communications — are a
higher tier, and a customer can only ever reach their own data.

## The `support.*` permission group

Defined in `permissions.ts` (and grouped for the Roles UI under `Support`):

```
support.read              support.respond          support.assign
support.notes.write       support.escalate         support.resolve
support.attachments.read  support.evidence.manage
support.remediation.request   support.remediation.approve
support.refund.request        support.refund.approve
support.config.manage     support.templates.manage    support.mass_notify
```

## Role defaults (`rbac.ts`)

**SUPPORT** (the front line) — `SUPPORT_DEFAULTS` include:

```
support.read, support.respond, support.assign, support.notes.write,
support.escalate, support.resolve, support.attachments.read,
support.evidence.manage, support.remediation.request, support.refund.request
```

Deliberately **absent** from SUPPORT: any approval, config, template or mass-notify
permission. The front line investigates, responds, and *requests* remediation — it
never approves financial remediation, never edits config/templates, and cannot send
mass notifications.

**ADMIN** — `ADMIN_ONLY_ADDITIONS` add the sensitive tier:

```
support.remediation.approve, support.refund.approve,
support.config.manage, support.templates.manage, support.mass_notify
```

**SUPER_ADMIN** (owner) holds every permission.

This split, combined with the four-eyes check in `approveRemediation` (doc 07),
means: a requester cannot approve their own remediation, and a front-line agent
cannot approve any remediation at all.

## HTTP guards

**Owner routes** (`owner-support.ts`, `/api/v1/admin/ops/support`) are each gated:

- reads and diagnostics → `requirePermission('support.read')`;
- replies, status, tags, link/unlink, merge/split → `support.respond`;
- notes → `support.notes.write`; assign/priority → `support.assign`;
- escalate → `support.escalate`; resolve/reopen → `support.resolve`;
- evidence → `support.evidence.manage`; attachment download →
  `support.attachments.read`;
- config → `support.config.manage`; templates → `support.templates.manage`;
- remediation request → `requireAnyPermission('support.remediation.request',
  'support.refund.request')`, then a **per-type** check in the handler: a `REFUND`
  needs `support.refund.request`, everything else needs
  `support.remediation.request`;
- approve / deny / execute → `requireAnyPermission('support.remediation.approve',
  'support.refund.approve')`, then a **per-remediation** gate (`remediationGate`)
  that loads the row and requires `support.refund.approve` for a `REFUND` or
  `support.remediation.approve` otherwise.

**Customer routes** (`support-portal.ts`, `/api/v1/support`) require an
authenticated user and are scoped to that user's own tickets. The helper
`ownTicketOr404(userId, ticketId)` loads the ticket and returns **404** (not 403)
if it isn't the caller's — a customer cannot even confirm another ticket exists.
`customerTicketView` re-checks ownership before returning anything.

## Rate limits

Customer write endpoints are rate-limited: ticket creation 10/min, messages 30/min,
attachments 20/min. The config also carries `ticketRateLimitPerHour` and a
duplicate-detection window to blunt spam.

## Threats mitigated

- **Cross-customer ticket access** — every customer route resolves through
  `ownTicketOr404` / `customerTicketView`, returning 404 for anything not owned by
  the caller. No enumeration signal is leaked.
- **Internal-note leakage** — the customer projection filters to `CUSTOMER`
  visibility and renames staff to "Happy Trader Support"; internal notes and
  internal attachments are never in a customer payload (doc 04).
- **IDOR on attachments** — downloads need a short-lived HMAC token *and* an
  ownership/role match; guessing an id is not enough (doc 08).
- **Privilege escalation on money actions** — support cannot approve; approvals are
  admin-tier; and the four-eyes rule blocks a requester approving their own request.
- **Tampering with the record** — messages, evidence and lifecycle events are
  append-only at the database; nothing can be quietly rewritten.

## A note on `support.mass_notify`

The `support.mass_notify` permission is defined and assigned to the admin tier, but
no HTTP endpoint consumes it in this milestone — it reserves the capability for a
future mass-communication surface. Treat it as declared-but-not-yet-wired (see doc
13, runbook h).
