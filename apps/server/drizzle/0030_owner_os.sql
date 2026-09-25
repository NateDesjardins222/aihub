-- Milestone 10: Owner Operating System / Control Plane.
-- Granular RBAC, staff lifecycle, impersonation, operational surfaces,
-- System Doctor + Data Integrity results, feature flags + kill switches,
-- maker-checker approvals, append-only admin adjustments, export jobs.
-- Owner change history reuses audit_log; activity reuses domain_events; holds
-- reuse enforcement_holds; notifications reuse notification_messages.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enrolled" boolean NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "invited_by_user_id" uuid;

CREATE TABLE IF NOT EXISTS "staff_permissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "permission" varchar(64) NOT NULL,
  "effect" varchar(8) NOT NULL DEFAULT 'GRANT',
  "granted_by_user_id" uuid,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "staff_permissions_user_perm_key" ON "staff_permissions" ("user_id","permission");
CREATE INDEX IF NOT EXISTS "staff_permissions_user_idx" ON "staff_permissions" ("user_id");

CREATE TABLE IF NOT EXISTS "staff_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "email" varchar(254) NOT NULL,
  "display_name" varchar(60),
  "role" varchar(16) NOT NULL DEFAULT 'SUPPORT',
  "permissions" jsonb,
  "token_hash" text NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'INVITED',
  "invited_by_user_id" uuid,
  "accepted_user_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "staff_invitations_token_key" ON "staff_invitations" ("token_hash");
CREATE INDEX IF NOT EXISTS "staff_invitations_email_idx" ON "staff_invitations" ("email");
CREATE INDEX IF NOT EXISTS "staff_invitations_status_idx" ON "staff_invitations" ("status");

CREATE TABLE IF NOT EXISTS "impersonation_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "operator_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "target_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "reason" text NOT NULL,
  "mode" varchar(16) NOT NULL DEFAULT 'READ_ONLY',
  "status" varchar(12) NOT NULL DEFAULT 'ACTIVE',
  "token_hash" text NOT NULL,
  "originating_request_id" varchar(64),
  "ip" varchar(64),
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "impersonation_sessions_token_key" ON "impersonation_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_operator_idx" ON "impersonation_sessions" ("operator_user_id");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_status_idx" ON "impersonation_sessions" ("status");

CREATE TABLE IF NOT EXISTS "saved_views" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scope" varchar(40) NOT NULL,
  "name" varchar(80) NOT NULL,
  "filters" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "visibility" varchar(12) NOT NULL DEFAULT 'PERSONAL',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "saved_views_scope_idx" ON "saved_views" ("scope");
CREATE INDEX IF NOT EXISTS "saved_views_owner_idx" ON "saved_views" ("owner_user_id");

CREATE TABLE IF NOT EXISTS "internal_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "subject_type" varchar(24) NOT NULL,
  "subject_id" varchar(64) NOT NULL,
  "author_user_id" uuid REFERENCES "users"("id"),
  "author_label" varchar(120),
  "body" text NOT NULL,
  "pinned" boolean NOT NULL DEFAULT false,
  "visibility" varchar(16) NOT NULL DEFAULT 'INTERNAL',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "internal_notes_subject_idx" ON "internal_notes" ("subject_type","subject_id");

CREATE TABLE IF NOT EXISTS "ops_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "title" varchar(160) NOT NULL,
  "description" text,
  "status" varchar(12) NOT NULL DEFAULT 'OPEN',
  "priority" varchar(8) NOT NULL DEFAULT 'NORMAL',
  "assignee_user_id" uuid REFERENCES "users"("id"),
  "creator_user_id" uuid REFERENCES "users"("id"),
  "subject_type" varchar(24),
  "subject_id" varchar(64),
  "due_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "ops_tasks_status_idx" ON "ops_tasks" ("status");
CREATE INDEX IF NOT EXISTS "ops_tasks_assignee_idx" ON "ops_tasks" ("assignee_user_id");

CREATE TABLE IF NOT EXISTS "incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "public_ref" varchar(20) NOT NULL,
  "title" varchar(200) NOT NULL,
  "severity" varchar(12) NOT NULL DEFAULT 'WARNING',
  "status" varchar(16) NOT NULL DEFAULT 'OPEN',
  "source" varchar(40),
  "affected_subsystem" varchar(40),
  "dedupe_key" varchar(120),
  "assignee_user_id" uuid REFERENCES "users"("id"),
  "acknowledged_by_user_id" uuid,
  "acknowledged_at" timestamp with time zone,
  "detected_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "resolution" text,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "incidents_public_ref_key" ON "incidents" ("public_ref");
CREATE INDEX IF NOT EXISTS "incidents_status_idx" ON "incidents" ("status");
CREATE INDEX IF NOT EXISTS "incidents_dedupe_idx" ON "incidents" ("dedupe_key");

CREATE TABLE IF NOT EXISTS "incident_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "incident_id" uuid NOT NULL REFERENCES "incidents"("id") ON DELETE CASCADE,
  "link_type" varchar(16) NOT NULL,
  "ref_id" varchar(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "incident_links_incident_idx" ON "incident_links" ("incident_id");

CREATE TABLE IF NOT EXISTS "alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "severity" varchar(12) NOT NULL DEFAULT 'INFO',
  "category" varchar(40) NOT NULL,
  "title" varchar(200) NOT NULL,
  "body" text,
  "dedupe_key" varchar(120),
  "status" varchar(12) NOT NULL DEFAULT 'OPEN',
  "incident_id" uuid REFERENCES "incidents"("id"),
  "source" varchar(40),
  "count" integer NOT NULL DEFAULT 1,
  "subject_type" varchar(24),
  "subject_id" varchar(64),
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acknowledged_by_user_id" uuid,
  "acknowledged_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "alerts_status_idx" ON "alerts" ("status");
CREATE INDEX IF NOT EXISTS "alerts_severity_idx" ON "alerts" ("severity");
CREATE INDEX IF NOT EXISTS "alerts_dedupe_idx" ON "alerts" ("dedupe_key");

CREATE TABLE IF NOT EXISTS "alert_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "channel" varchar(8) NOT NULL DEFAULT 'IN_APP',
  "min_severity" varchar(12) NOT NULL DEFAULT 'WARNING',
  "categories" jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "quiet_hours" jsonb,
  "escalation_eligible" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "alert_subscriptions_user_channel_key" ON "alert_subscriptions" ("user_id","channel");

CREATE TABLE IF NOT EXISTS "system_check_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "check_key" varchar(60) NOT NULL,
  "status" varchar(12) NOT NULL,
  "severity" varchar(12) NOT NULL DEFAULT 'INFO',
  "expected" text,
  "actual" text,
  "duration_ms" integer,
  "run_id" varchar(40),
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "system_check_results_key_idx" ON "system_check_results" ("check_key","created_at");

CREATE TABLE IF NOT EXISTS "integrity_check_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "check_key" varchar(60) NOT NULL,
  "status" varchar(8) NOT NULL,
  "severity" varchar(12) NOT NULL DEFAULT 'INFO',
  "affected_count" integer NOT NULL DEFAULT 0,
  "expected" text,
  "actual" text,
  "sample_refs" jsonb,
  "run_id" varchar(40),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "integrity_check_results_key_idx" ON "integrity_check_results" ("check_key","created_at");

CREATE TABLE IF NOT EXISTS "feature_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "key" varchar(60) NOT NULL,
  "environment" varchar(12) NOT NULL DEFAULT 'ALL',
  "enabled" boolean NOT NULL DEFAULT false,
  "description" text,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "feature_flags_key_env_key" ON "feature_flags" ("key","environment");

CREATE TABLE IF NOT EXISTS "kill_switches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "key" varchar(48) NOT NULL,
  "engaged" boolean NOT NULL DEFAULT false,
  "reason" text,
  "engaged_by_user_id" uuid,
  "engaged_at" timestamp with time zone,
  "released_by_user_id" uuid,
  "released_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "kill_switches_key_key" ON "kill_switches" ("key");

CREATE TABLE IF NOT EXISTS "admin_approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "action" varchar(60) NOT NULL,
  "payload" jsonb,
  "reason" text,
  "status" varchar(12) NOT NULL DEFAULT 'REQUESTED',
  "requested_by_user_id" uuid NOT NULL,
  "decided_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  "executed_at" timestamp with time zone,
  "subject_type" varchar(24),
  "subject_id" varchar(64),
  "linked_incident_id" uuid,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "admin_approval_requests_status_idx" ON "admin_approval_requests" ("status");

CREATE TABLE IF NOT EXISTS "admin_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "account_id" uuid REFERENCES "accounts"("id"),
  "user_id" uuid REFERENCES "users"("id"),
  "type" varchar(24) NOT NULL,
  "amount_micros" bigint,
  "reason_code" varchar(40) NOT NULL,
  "explanation" text NOT NULL,
  "before_snapshot" jsonb,
  "after_snapshot" jsonb,
  "linked_incident_id" uuid,
  "linked_case_id" uuid,
  "actor_user_id" uuid,
  "effective_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "admin_adjustments_account_idx" ON "admin_adjustments" ("account_id");

CREATE TABLE IF NOT EXISTS "export_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "kind" varchar(40) NOT NULL,
  "filters" jsonb,
  "status" varchar(12) NOT NULL DEFAULT 'QUEUED',
  "requested_by_user_id" uuid NOT NULL,
  "row_count" integer,
  "result_ref" text,
  "error" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "export_jobs_status_idx" ON "export_jobs" ("status");

-- Append-only guard for admin_adjustments (financial corrections never rewritten).
CREATE OR REPLACE FUNCTION "owner_os_block_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_adjustments is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "admin_adjustments_no_update" ON "admin_adjustments";
CREATE TRIGGER "admin_adjustments_no_update" BEFORE UPDATE OR DELETE ON "admin_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "owner_os_block_mutation"();
