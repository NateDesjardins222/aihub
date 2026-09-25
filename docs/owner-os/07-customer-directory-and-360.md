# Owner OS — Customer Directory & 360

Module: `customer-directory.ts`
Routes: `/api/v1/admin/ops/customers` (directory), tags endpoints, and the
existing customer 360 surfaces.

## Directory

`customerDirectory(db, org, opts)` lists customers with batched aggregates so the
page is one query set, not N+1:

- lifetime spend (from commercial orders)
- active account count / funded account count
- lifetime paid out
- segment membership

Pagination is **keyset** (cursor-based), never offset, so it scales to large
customer bases without slow deep pages.

## Segments

Server-computed segments include `funded` (has a funded account) and `paid_out`
(has a PAID payout, lifetime paid > 0). Segments are computed from source objects,
not stored flags, so they cannot drift.

## Tags

`addTag` / `removeTag` / `listTags` maintain `customer_tags`. Tags are normalized
(trimmed, uppercased) and idempotent — adding the same tag twice is a no-op.
Empty tags and non-customers are rejected. Writing a tag requires
`customers.tags.write`.

## Customer 360

The 360 view stitches the directory row together with identity, accounts, payouts,
enforcement, certificates, notes and copy-trading membership — all read surfaces,
each gated by the relevant `*.read` permission. Internal notes are written via
`customers.notes.write` and are pinned-first.
