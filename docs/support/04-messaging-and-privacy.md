# 04 — Messaging & privacy

One append-only thread per ticket carries the entire conversation — customer
replies, staff public replies and staff internal notes — in `support_messages`.
The privacy boundary between what a customer sees and what stays internal is
enforced in the domain, not just the UI.

## Message shape

Each message (`support-tickets.ts` `addMessage`) records:

- `sender_type`: `CUSTOMER`, `STAFF`, or `SYSTEM`.
- `visibility`: `CUSTOMER` (visible to the customer) or `INTERNAL` (staff-only).
- `body`, optional `mentions`, and a per-ticket `idempotency_key`.

The table is append-only at the database level (see doc 02): a message is never
edited or deleted. A correction is a new message.

## What the domain enforces

`addMessage` refuses to let privacy be violated at the source:

- A `CUSTOMER` sender with any visibility other than `CUSTOMER` is rejected
  (`A customer cannot post an internal note.`).
- A `CUSTOMER` cannot post to a terminal (resolved/closed) ticket — they are told
  to reopen or open a new request.
- Only a staff public reply (`STAFF` + `CUSTOMER`) stamps `last_staff_at` and the
  SLA first-response timestamp; an internal note does not (an internal note is not
  a response to the customer).

The customer routes never expose the internal path: `POST /tickets/:id/messages`
hard-codes `senderType: 'CUSTOMER'`, `visibility: 'CUSTOMER'`. Staff have two
distinct routes — `/reply` (public, `visibility: CUSTOMER`, needs
`support.respond`) and `/note` (internal, `visibility: INTERNAL`, needs
`support.notes.write`).

## Idempotency

Messages are idempotent per `(ticket_id, idempotency_key)`. `addMessage` first
looks up the key; if a row exists it returns `{ deduped: true }`. If two requests
race, the unique index catches the loser and the handler falls back to returning
the existing row. A retried client send never produces a duplicate.

## The customer projection — internal notes never leak

Two mechanisms guarantee a customer never sees internal content or staff
identities:

1. **`listMessages(db, ticketId, { includeInternal })`** (`support-tickets.ts`).
   The staff workspace passes `includeInternal: true`; the customer view passes
   `false`, which filters the thread down to `visibility === 'CUSTOMER'` rows only.
   In the customer projection the sender name is generalised: a customer's own
   messages read "You", and every staff message reads **"Happy Trader Support"** —
   an individual staff member's display name is never returned to a customer.

2. **`customerTicketView`** (`support-inbox.ts`) is the only assembler the customer
   portal uses. It re-checks ownership (`organizationId` + `customerUserId`) and
   calls `listMessages(..., { includeInternal: false })` and
   `listAttachments(..., { includeInternal: false })`, returning a minimal ticket
   shape (no internal notes, no internal attachments, no internal resolution
   notes, no assignee, no root cause).

The internal-only fields — `resolution_notes_internal`, internal messages,
internal attachments — are simply never part of any customer-facing payload. The
`INV`-style protection is reinforced by the append-only guarantee: internal notes
cannot later be rewritten to hide or alter what was recorded.

## System messages

`SYSTEM` messages (e.g. an escalation note) may be written by internal flows. Like
staff notes, whether a customer sees them is governed solely by `visibility`, and
the customer projection applies the same filter.
