-- Milestone 12 — Customer Support, Disputes & Resolution Operations.
-- Messages, evidence, and ticket lifecycle events are append-only (a trigger
-- blocks UPDATE/DELETE). Money on a remediation is micros (bigint), never a float.

CREATE TABLE IF NOT EXISTS "support_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "version" integer NOT NULL,
  "settings" jsonb NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_config_org_version_key" ON "support_config" ("organization_id","version");

CREATE TABLE IF NOT EXISTS "support_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "key" varchar(48) NOT NULL,
  "parent_key" varchar(48),
  "label" varchar(120) NOT NULL,
  "team" varchar(32),
  "default_priority" varchar(16) NOT NULL DEFAULT 'NORMAL',
  "sort_order" integer NOT NULL DEFAULT 0,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_categories_org_key" ON "support_categories" ("organization_id","key");

CREATE TABLE IF NOT EXISTS "support_sla_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "key" varchar(48) NOT NULL,
  "name" varchar(120) NOT NULL,
  "first_response_mins_by_priority" jsonb NOT NULL,
  "resolution_mins_by_priority" jsonb NOT NULL,
  "pause_on_waiting" boolean NOT NULL DEFAULT true,
  "business_hours" jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_sla_policies_org_key" ON "support_sla_policies" ("organization_id","key");

CREATE TABLE IF NOT EXISTS "support_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "key" varchar(48) NOT NULL,
  "name" varchar(120) NOT NULL,
  "category" varchar(48),
  "body" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "version" integer NOT NULL DEFAULT 1,
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_templates_org_key" ON "support_templates" ("organization_id","key");

CREATE TABLE IF NOT EXISTS "support_kb_articles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "slug" varchar(80) NOT NULL,
  "title" varchar(200) NOT NULL,
  "category" varchar(48),
  "body" text NOT NULL,
  "published" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "version" integer NOT NULL DEFAULT 1,
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_kb_articles_org_slug" ON "support_kb_articles" ("organization_id","slug");

CREATE TABLE IF NOT EXISTS "support_tag_defs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "tag" varchar(40) NOT NULL,
  "label" varchar(80),
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_tag_defs_org_tag" ON "support_tag_defs" ("organization_id","tag");

CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "public_ref" varchar(20) NOT NULL,
  "customer_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "customer_identity_id" uuid REFERENCES "customer_identities"("id"),
  "category_key" varchar(48) NOT NULL,
  "subcategory_key" varchar(48),
  "subject" varchar(200) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'OPEN',
  "priority" varchar(16) NOT NULL DEFAULT 'NORMAL',
  "customer_urgency" varchar(16),
  "suggested_priority" varchar(16),
  "assignee_user_id" uuid REFERENCES "users"("id"),
  "team" varchar(32),
  "sla_policy_key" varchar(48),
  "first_response_due_at" timestamptz,
  "resolution_due_at" timestamptz,
  "sla_paused_at" timestamptz,
  "sla_first_responded_at" timestamptz,
  "incident_id" uuid,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "resolution_code" varchar(40),
  "resolution_summary_customer" text,
  "resolution_notes_internal" text,
  "root_cause_category" varchar(40),
  "reopened_from_ticket_id" uuid,
  "follow_up_to_ticket_id" uuid,
  "merged_into_ticket_id" uuid,
  "csat_rating" integer,
  "csat_comment" text,
  "version" integer NOT NULL DEFAULT 1,
  "last_customer_at" timestamptz,
  "last_staff_at" timestamptz,
  "resolved_at" timestamptz,
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_tickets_public_ref_key" ON "support_tickets" ("public_ref");
CREATE INDEX IF NOT EXISTS "support_tickets_org_status_idx" ON "support_tickets" ("organization_id","status");
CREATE INDEX IF NOT EXISTS "support_tickets_customer_idx" ON "support_tickets" ("customer_user_id");
CREATE INDEX IF NOT EXISTS "support_tickets_assignee_idx" ON "support_tickets" ("organization_id","assignee_user_id");
CREATE INDEX IF NOT EXISTS "support_tickets_team_idx" ON "support_tickets" ("organization_id","team");
CREATE INDEX IF NOT EXISTS "support_tickets_priority_idx" ON "support_tickets" ("organization_id","priority");
CREATE INDEX IF NOT EXISTS "support_tickets_category_idx" ON "support_tickets" ("organization_id","category_key");
CREATE INDEX IF NOT EXISTS "support_tickets_updated_idx" ON "support_tickets" ("organization_id","updated_at");
CREATE INDEX IF NOT EXISTS "support_tickets_sla_due_idx" ON "support_tickets" ("organization_id","resolution_due_at");
CREATE INDEX IF NOT EXISTS "support_tickets_incident_idx" ON "support_tickets" ("incident_id");

CREATE TABLE IF NOT EXISTS "support_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "ticket_id" uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
  "sender_user_id" uuid REFERENCES "users"("id"),
  "sender_type" varchar(16) NOT NULL,
  "visibility" varchar(16) NOT NULL DEFAULT 'CUSTOMER',
  "body" text NOT NULL,
  "mentions" jsonb,
  "delivery_state" varchar(16),
  "idempotency_key" varchar(80),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "support_messages_ticket_idx" ON "support_messages" ("ticket_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "support_messages_idem_key" ON "support_messages" ("ticket_id","idempotency_key");

CREATE TABLE IF NOT EXISTS "support_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "ticket_id" uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
  "message_id" uuid REFERENCES "support_messages"("id"),
  "uploader_user_id" uuid REFERENCES "users"("id"),
  "uploader_type" varchar(16) NOT NULL,
  "filename" varchar(255) NOT NULL,
  "content_type" varchar(100) NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage_key" varchar(255) NOT NULL,
  "checksum" varchar(64),
  "scan_status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "visibility" varchar(16) NOT NULL DEFAULT 'CUSTOMER',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "support_attachments_ticket_idx" ON "support_attachments" ("ticket_id");

CREATE TABLE IF NOT EXISTS "support_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "ticket_id" uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
  "source_type" varchar(16) NOT NULL,
  "source_ref" varchar(128) NOT NULL,
  "object_type" varchar(40),
  "description" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "support_evidence_ticket_idx" ON "support_evidence" ("ticket_id");

CREATE TABLE IF NOT EXISTS "support_ticket_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "ticket_id" uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
  "object_type" varchar(40) NOT NULL,
  "object_id" varchar(128) NOT NULL,
  "label" varchar(200),
  "auto" boolean NOT NULL DEFAULT false,
  "linked_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_ticket_links_unique" ON "support_ticket_links" ("ticket_id","object_type","object_id");
CREATE INDEX IF NOT EXISTS "support_ticket_links_object_idx" ON "support_ticket_links" ("object_type","object_id");

CREATE TABLE IF NOT EXISTS "support_ticket_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "ticket_id" uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
  "type" varchar(40) NOT NULL,
  "from_value" varchar(64),
  "to_value" varchar(64),
  "actor_user_id" uuid REFERENCES "users"("id"),
  "actor_type" varchar(16) NOT NULL DEFAULT 'STAFF',
  "reason" text,
  "detail" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "support_ticket_events_ticket_idx" ON "support_ticket_events" ("ticket_id","created_at");

CREATE TABLE IF NOT EXISTS "support_remediations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "ticket_id" uuid NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
  "public_ref" varchar(24) NOT NULL,
  "type" varchar(40) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'REQUESTED',
  "requested_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "reason" text NOT NULL,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "amount_micros" bigint,
  "approved_by_user_id" uuid REFERENCES "users"("id"),
  "approved_at" timestamptz,
  "denied_reason" text,
  "executed_at" timestamptz,
  "execution_ref" varchar(128),
  "failure_reason" text,
  "idempotency_key" varchar(80),
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "support_remediations_public_ref_key" ON "support_remediations" ("public_ref");
CREATE UNIQUE INDEX IF NOT EXISTS "support_remediations_idem_key" ON "support_remediations" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "support_remediations_ticket_idx" ON "support_remediations" ("ticket_id");
CREATE INDEX IF NOT EXISTS "support_remediations_status_idx" ON "support_remediations" ("organization_id","status");

-- Append-only guards: messages, evidence and the ticket's lifecycle events are
-- an evidentiary record that must never be rewritten or deleted.
CREATE OR REPLACE FUNCTION "support_block_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "support_messages_no_update" ON "support_messages";
CREATE TRIGGER "support_messages_no_update" BEFORE UPDATE OR DELETE ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION "support_block_mutation"();

DROP TRIGGER IF EXISTS "support_evidence_no_update" ON "support_evidence";
CREATE TRIGGER "support_evidence_no_update" BEFORE UPDATE OR DELETE ON "support_evidence"
  FOR EACH ROW EXECUTE FUNCTION "support_block_mutation"();

DROP TRIGGER IF EXISTS "support_ticket_events_no_update" ON "support_ticket_events";
CREATE TRIGGER "support_ticket_events_no_update" BEFORE UPDATE OR DELETE ON "support_ticket_events"
  FOR EACH ROW EXECUTE FUNCTION "support_block_mutation"();
