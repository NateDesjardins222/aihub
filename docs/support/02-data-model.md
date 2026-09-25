# 02 — Data model

Thirteen tables, defined in `apps/server/src/db/schema.ts` (from `supportConfig`
onward) and created by migration `drizzle/0034_support.sql`. Every money field is
integer **micros** (`bigint`); no floating-point money exists. Three tables are
append-only at the database level (see the trigger at the end).

## Configuration tables

### `support_config` (versioned)
One row per version, keyed unique on `(organization_id, version)`. `settings` is a
JSONB blob (`SupportSettings`: reopen window, attachment limits, rate limits,
duplicate window, CSAT flag, teams, default SLA policy key). A change appends a new
version; history is preserved, exactly like the affiliate program config. v1 plus
the default category tree and default SLA are seeded on first read.

### `support_categories`
The category tree (unique on `(organization_id, key)`): `key`, optional
`parent_key`, `label`, `team`, `default_priority`, `sort_order`, `active`. Seeded
from `DEFAULT_CATEGORIES`.

### `support_sla_policies`
Named SLA policies (unique on `(organization_id, key)`):
`first_response_mins_by_priority` and `resolution_mins_by_priority` (JSONB maps),
`pause_on_waiting`, `business_hours` (JSONB), `version`, `active`.

### `support_templates`
Canned reply templates (unique on `(organization_id, key)`): `name`, `category`,
`body`, `active`, `version`, `updated_by_user_id`.

### `support_kb_articles`
Public knowledge-base articles (unique on `(organization_id, slug)`): `title`,
`category`, `body`, `published`, `sort_order`, `version`.

### `support_tag_defs`
Defined ticket tags (unique on `(organization_id, tag)`): `tag`, `label`,
`active`.

## The ticket

### `support_tickets`
The central record.

- **Identity:** `public_ref` (`HT-XXXXXX`, unique across the table, non-sequential,
  no ambiguous characters), `customer_user_id`, `customer_identity_id`.
- **Classification:** `category_key`, `subcategory_key`, `subject`, `team`, `tags`
  (JSONB array).
- **State:** `status` (default `OPEN`), `priority` (default `NORMAL`),
  `customer_urgency` (what the customer indicated), `suggested_priority` (the
  deterministic suggestion), `assignee_user_id`.
- **SLA:** `sla_policy_key`, `first_response_due_at`, `resolution_due_at`,
  `sla_paused_at`, `sla_first_responded_at`.
- **Resolution:** `resolution_code`, `resolution_summary_customer` (customer-safe),
  `resolution_notes_internal` (staff-only), `root_cause_category`.
- **Relationships:** `incident_id`, `reopened_from_ticket_id`,
  `follow_up_to_ticket_id` (split), `merged_into_ticket_id` (merge).
- **CSAT:** `csat_rating`, `csat_comment`.
- **Concurrency:** `version` — optimistic-concurrency guard; staff status changes
  and resolution pass an `expectedVersion`.
- **Timestamps:** `last_customer_at`, `last_staff_at`, `resolved_at`, `closed_at`,
  `created_at`, `updated_at`.

Indexed by status, customer, assignee, team, priority, category, updated-at,
resolution-due-at and incident.

## Append-only conversation & evidence

### `support_messages` (append-only)
The single thread carrying customer replies, staff public replies and internal
notes: `sender_user_id`, `sender_type` (`CUSTOMER` | `STAFF` | `SYSTEM`),
`visibility` (`CUSTOMER` | `INTERNAL`, default `CUSTOMER`), `body`, `mentions`,
`delivery_state`, `idempotency_key`. Unique on `(ticket_id, idempotency_key)` so a
retried client message collapses to one row.

### `support_attachments`
Uploaded files: `message_id`, `uploader_type`, `filename`, `content_type`,
`size_bytes`, `storage_key`, `checksum`, `scan_status` (default `PENDING`),
`visibility` (default `CUSTOMER`). Bytes live behind the storage seam, referenced
only by `storage_key`.

### `support_evidence` (append-only)
Curated case evidence: `source_type` (`ATTACHMENT` | `OBJECT` | `EVENT`),
`source_ref`, `object_type`, `description`, `created_by_user_id`.

### `support_ticket_links`
Typed links from a ticket to real business objects: `object_type`, `object_id`,
`label`, `auto`, `linked_by_user_id`. Unique on
`(ticket_id, object_type, object_id)`; also indexed on `(object_type, object_id)`
so "which tickets touch this object" is cheap.

### `support_ticket_events` (append-only)
The ticket's own lifecycle log: `type` (e.g. `CREATED`, `STATUS_CHANGED`,
`ASSIGNED`, `PRIORITY_CHANGED`, `ESCALATED`, `RESOLVED`, `REOPENED`, `MERGED`,
`SPLIT`), `from_value`, `to_value`, `actor_user_id`, `actor_type`, `reason`,
`detail` (JSONB).

## Remediation

### `support_remediations`
A requested remedy and its lifecycle: `public_ref` (`REM-XXXXXX`, unique), `type`,
`status` (default `REQUESTED`), `requested_by_user_id`, `reason`, `detail` (JSONB),
`amount_micros` (`bigint`, nullable), `approved_by_user_id`, `approved_at`,
`denied_reason`, `executed_at`, `execution_ref`, `failure_reason`,
`idempotency_key` (unique), `version`. Indexed by ticket and by
`(organization_id, status)`.

## The append-only guard

Messages, evidence and ticket lifecycle events are an evidentiary record that must
never be rewritten or deleted. The migration defines:

```sql
CREATE OR REPLACE FUNCTION "support_block_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
```

and attaches it as a `BEFORE UPDATE OR DELETE` trigger to `support_messages`,
`support_evidence` and `support_ticket_events`. Any attempt to update or delete a
row in those tables raises at the database, regardless of the application path.
The ticket itself is mutable (status, assignment, SLA clock) but every mutation is
mirrored into the append-only event log and the audit stream.
