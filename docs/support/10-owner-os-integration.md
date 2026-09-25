# 10 — Owner OS integration

Support is not a silo — it is woven into the Owner OS so an operator sees support
pressure alongside everything else and can pivot between a ticket and the objects
it touches.

## Command Center

`command-center.ts` folds `supportOverview` into the Command Center payload
(swallowing failure so support can't take the dashboard down). It contributes:

- **Attention items:**
  - `CRITICAL` — `<n> support ticket(s) past SLA` (when `breached > 0`),
    linking to `/admin/support`;
  - `WARNING` — `<n> remediation(s) awaiting approval` (when
    `pendingRemediationApprovals > 0`);
  - `WARNING` — `<n> unassigned support ticket(s)`, linking to
    `/admin/support?view=UNASSIGNED`.
- **KPIs:** `openSupportTickets`, `supportSlaBreached`,
  `pendingRemediationApprovals`, `supportCsatAverage`.

## Global search

`search.ts` adds two result groups:

- **`support_ticket`** — matches a ticket id (UUID) or a substring of its public
  ref or subject; returns `{ label: publicRef, sublabel: subject }`.
- **`support_remediation`** — matches a remediation id or its `REM-` public ref;
  the result's `id` is the **ticket** id (so selecting it opens the ticket), with
  `sublabel` = `<type> · <status>`.

## Object explorer

`object-explorer.ts` resolves the `support_ticket` object type: it returns the
ticket's public ref, a state summary (subject, status, priority, category, team,
assignee, resolution code, CSAT), and **related** links — the customer plus every
object linked to the ticket (via `listLinks`), so an operator can jump straight
from a ticket to the account, order or payout behind it. Its history is drawn from
the customer's audit trail.

## Customer 360

`owner-customer.ts` `customerDetail` adds a read-only **Support** tab: the
customer's tickets (public ref, subject, category, status, priority, timestamps,
CSAT), ordered by most-recently-updated. It is explicitly read-only — Customer 360
never mutates a ticket. The web renders it in `apps/web/src/admin/pages/CustomersPage.tsx`
under a "Support" panel, each row linking to `/admin/support/<id>`.

## Web navigation

`apps/web/src/admin/AdminApp.tsx` registers the top-level **Support** nav item and
two routes: the inbox (`/admin/support` → `SupportInboxPage`) and a single ticket
(`/admin/support/<id>` → `SupportTicketPage`), both in
`apps/web/src/admin/pages/SupportPages.tsx`. The customer-facing surface is
`apps/web/src/portal/pages/SupportPage.tsx` at `/portal/support`.
