-- Milestone 7 — Prohibited Conduct + Enforcement + Appeals.
--
-- Additive only. A signal is not a finding; a temporary hold is not a conviction;
-- a rule breach is not misconduct. These tables record investigations, evidence,
-- holds and appeals, SEPARATE from account lifecycle status. Policy acceptance
-- reuses the existing agreements tables (TRADER_PLEDGE) — no policy_acceptances
-- table is created here.

CREATE TABLE IF NOT EXISTS "enforcement_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE cascade,
  "subject_account_id" uuid REFERENCES "accounts"("id") ON DELETE set null,
  "category" varchar(32) NOT NULL,
  "severity" varchar(12) NOT NULL DEFAULT 'LOW',
  "status" varchar(24) NOT NULL DEFAULT 'OPEN',
  "customer_safe_category" varchar(40) NOT NULL DEFAULT 'GENERAL_REVIEW',
  "reason_code" varchar(48),
  "assigned_to_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "correlation_key" varchar(120),
  "public_ref" varchar(24) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS "enforcement_cases_org_status_idx" ON "enforcement_cases" ("organization_id","status");
CREATE INDEX IF NOT EXISTS "enforcement_cases_identity_idx" ON "enforcement_cases" ("customer_identity_id");
CREATE INDEX IF NOT EXISTS "enforcement_cases_assigned_idx" ON "enforcement_cases" ("assigned_to_user_id");
CREATE INDEX IF NOT EXISTS "enforcement_cases_correlation_idx" ON "enforcement_cases" ("organization_id","correlation_key");
CREATE UNIQUE INDEX IF NOT EXISTS "enforcement_cases_public_ref_key" ON "enforcement_cases" ("organization_id","public_ref");

CREATE TABLE IF NOT EXISTS "enforcement_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "case_id" uuid REFERENCES "enforcement_cases"("id") ON DELETE set null,
  "customer_identity_id" uuid REFERENCES "customer_identities"("id") ON DELETE cascade,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE set null,
  "source" varchar(24) NOT NULL,
  "kind" varchar(48) NOT NULL,
  "severity" varchar(12) NOT NULL DEFAULT 'INFO',
  "source_ref" varchar(200),
  "metadata" jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  "dedupe_key" varchar(200) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "enforcement_signals_dedupe_key" ON "enforcement_signals" ("organization_id","dedupe_key");
CREATE INDEX IF NOT EXISTS "enforcement_signals_org_kind_idx" ON "enforcement_signals" ("organization_id","kind");
CREATE INDEX IF NOT EXISTS "enforcement_signals_case_idx" ON "enforcement_signals" ("case_id");
CREATE INDEX IF NOT EXISTS "enforcement_signals_identity_idx" ON "enforcement_signals" ("customer_identity_id");

CREATE TABLE IF NOT EXISTS "enforcement_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "case_id" uuid NOT NULL REFERENCES "enforcement_cases"("id") ON DELETE cascade,
  "type" varchar(40) NOT NULL,
  "source" varchar(24) NOT NULL,
  "source_ref" varchar(200),
  "visibility" varchar(16) NOT NULL DEFAULT 'INTERNAL',
  "metadata" jsonb,
  "integrity_hash" varchar(64),
  "occurred_at" timestamptz,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_by_system" boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS "enforcement_evidence_case_idx" ON "enforcement_evidence" ("case_id");
CREATE INDEX IF NOT EXISTS "enforcement_evidence_org_idx" ON "enforcement_evidence" ("organization_id");

CREATE TABLE IF NOT EXISTS "enforcement_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "case_id" uuid NOT NULL REFERENCES "enforcement_cases"("id") ON DELETE cascade,
  "reason_code" varchar(48) NOT NULL,
  "adverse" boolean NOT NULL DEFAULT false,
  "appealable" boolean NOT NULL DEFAULT false,
  "summary_safe" text,
  "rationale_internal" text,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
  "superseded_by_finding_id" uuid,
  "decided_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "enforcement_findings_case_idx" ON "enforcement_findings" ("case_id");

CREATE TABLE IF NOT EXISTS "enforcement_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "case_id" uuid REFERENCES "enforcement_cases"("id") ON DELETE set null,
  "scope" varchar(12) NOT NULL,
  "scope_id" uuid NOT NULL,
  "capability" varchar(24) NOT NULL,
  "reason_code" varchar(48) NOT NULL,
  "customer_safe_category" varchar(40) NOT NULL DEFAULT 'GENERAL_REVIEW',
  "status" varchar(12) NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_by_system" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "released_at" timestamptz,
  "released_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "release_reason" varchar(200),
  "version" integer NOT NULL DEFAULT 1,
  "idempotency_key" varchar(200) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "enforcement_holds_idem_key" ON "enforcement_holds" ("organization_id","idempotency_key");
CREATE INDEX IF NOT EXISTS "enforcement_holds_scope_idx" ON "enforcement_holds" ("organization_id","scope","scope_id","status");
CREATE INDEX IF NOT EXISTS "enforcement_holds_capability_idx" ON "enforcement_holds" ("capability","status");
CREATE INDEX IF NOT EXISTS "enforcement_holds_case_idx" ON "enforcement_holds" ("case_id");

CREATE TABLE IF NOT EXISTS "enforcement_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "case_id" uuid NOT NULL REFERENCES "enforcement_cases"("id") ON DELETE cascade,
  "action_type" varchar(40) NOT NULL,
  "reason_code" varchar(48),
  "scope" varchar(12),
  "scope_id" uuid,
  "hold_id" uuid REFERENCES "enforcement_holds"("id") ON DELETE set null,
  "performed_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "performed_by_system" boolean NOT NULL DEFAULT false,
  "metadata" jsonb,
  "performed_at" timestamptz NOT NULL DEFAULT now(),
  "idempotency_key" varchar(200) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "enforcement_actions_idem_key" ON "enforcement_actions" ("organization_id","idempotency_key");
CREATE INDEX IF NOT EXISTS "enforcement_actions_case_idx" ON "enforcement_actions" ("case_id");

CREATE TABLE IF NOT EXISTS "enforcement_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "case_id" uuid NOT NULL REFERENCES "enforcement_cases"("id") ON DELETE cascade,
  "author_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "body" text NOT NULL,
  "visibility" varchar(16) NOT NULL DEFAULT 'INTERNAL',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "enforcement_notes_case_idx" ON "enforcement_notes" ("case_id");

CREATE TABLE IF NOT EXISTS "enforcement_information_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "case_id" uuid NOT NULL REFERENCES "enforcement_cases"("id") ON DELETE cascade,
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE cascade,
  "request_type" varchar(48) NOT NULL,
  "message_safe" text NOT NULL,
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "due_at" timestamptz,
  "response_status" varchar(12) NOT NULL DEFAULT 'PENDING',
  "response_text" text,
  "responded_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "enforcement_info_requests_case_idx" ON "enforcement_information_requests" ("case_id");
CREATE INDEX IF NOT EXISTS "enforcement_info_requests_identity_idx" ON "enforcement_information_requests" ("customer_identity_id");

CREATE TABLE IF NOT EXISTS "enforcement_appeals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "case_id" uuid NOT NULL REFERENCES "enforcement_cases"("id") ON DELETE cascade,
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE cascade,
  "original_finding_id" uuid REFERENCES "enforcement_findings"("id") ON DELETE set null,
  "original_decider_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "customer_statement" text,
  "status" varchar(24) NOT NULL DEFAULT 'SUBMITTED',
  "reviewer_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "customer_safe_explanation" text,
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "decision_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "enforcement_appeals_case_key" ON "enforcement_appeals" ("case_id");
CREATE INDEX IF NOT EXISTS "enforcement_appeals_identity_idx" ON "enforcement_appeals" ("customer_identity_id");
CREATE INDEX IF NOT EXISTS "enforcement_appeals_status_idx" ON "enforcement_appeals" ("organization_id","status");

CREATE TABLE IF NOT EXISTS "enforcement_appeal_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "appeal_id" uuid NOT NULL REFERENCES "enforcement_appeals"("id") ON DELETE cascade,
  "case_id" uuid NOT NULL REFERENCES "enforcement_cases"("id") ON DELETE cascade,
  "decision" varchar(24) NOT NULL,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "rationale_internal" text,
  "customer_safe_explanation" text,
  "override_same_reviewer" boolean NOT NULL DEFAULT false,
  "override_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "decided_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "enforcement_appeal_decisions_appeal_idx" ON "enforcement_appeal_decisions" ("appeal_id");
CREATE INDEX IF NOT EXISTS "enforcement_appeal_decisions_case_idx" ON "enforcement_appeal_decisions" ("case_id");
