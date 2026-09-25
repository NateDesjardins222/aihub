-- Milestone 8 — Payout Operations. Additive only: no existing table or column is
-- altered. The economic spine (payout_requests.state, payout_ledger) is unchanged.

CREATE TABLE IF NOT EXISTS "payout_destinations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "provider" varchar(32) NOT NULL,
  "provider_ref" varchar(200),
  "destination_type" varchar(24) NOT NULL DEFAULT 'BANK_ACCOUNT',
  "masked_display" varchar(64),
  "ownership_state" varchar(24) NOT NULL DEFAULT 'UNVERIFIED',
  "status" varchar(24) NOT NULL DEFAULT 'PENDING',
  "capability" jsonb,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "verified_at" timestamptz,
  "disabled_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS "payout_destinations_identity_idx" ON "payout_destinations" ("customer_identity_id","status");
CREATE INDEX IF NOT EXISTS "payout_destinations_provider_ref_idx" ON "payout_destinations" ("provider","provider_ref");

CREATE TABLE IF NOT EXISTS "payout_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "payout_request_id" uuid NOT NULL REFERENCES "payout_requests"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "customer_identity_id" uuid REFERENCES "customer_identities"("id") ON DELETE SET NULL,
  "provider" varchar(32),
  "destination_id" uuid REFERENCES "payout_destinations"("id") ON DELETE SET NULL,
  "op_state" varchar(24) NOT NULL DEFAULT 'RECEIVED',
  "exception_category" varchar(32),
  "customer_safe_category" varchar(32),
  "fast_lane" boolean NOT NULL DEFAULT false,
  "provider_payout_id" varchar(200),
  "idempotency_key" varchar(200) NOT NULL,
  "sla_breached" boolean NOT NULL DEFAULT false,
  "last_error" varchar(300),
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "checks_started_at" timestamptz,
  "checks_completed_at" timestamptz,
  "approved_at" timestamptz,
  "payable_at" timestamptz,
  "submission_started_at" timestamptz,
  "submitted_at" timestamptz,
  "provider_processing_at" timestamptz,
  "paid_at" timestamptz,
  "reconciled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "payout_operations_request_key" ON "payout_operations" ("payout_request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payout_operations_idem_key" ON "payout_operations" ("organization_id","idempotency_key");
CREATE INDEX IF NOT EXISTS "payout_operations_state_idx" ON "payout_operations" ("organization_id","op_state");
CREATE INDEX IF NOT EXISTS "payout_operations_provider_payout_idx" ON "payout_operations" ("provider","provider_payout_id");

CREATE TABLE IF NOT EXISTS "payout_operational_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "payout_request_id" uuid NOT NULL REFERENCES "payout_requests"("id") ON DELETE CASCADE,
  "check_type" varchar(32) NOT NULL,
  "result" varchar(8) NOT NULL,
  "category" varchar(32),
  "detail_safe" varchar(300),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "payout_op_checks_request_idx" ON "payout_operational_checks" ("payout_request_id","created_at");

CREATE TABLE IF NOT EXISTS "payout_submission_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "payout_request_id" uuid NOT NULL REFERENCES "payout_requests"("id") ON DELETE CASCADE,
  "provider" varchar(32) NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "attempt_number" integer NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "provider_payout_id" varchar(200),
  "request_hash" varchar(64),
  "normalized_result" varchar(24),
  "error_category" varchar(24),
  "retryable" boolean NOT NULL DEFAULT false,
  "correlation_id" varchar(64),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "payout_attempts_request_idx" ON "payout_submission_attempts" ("payout_request_id","attempt_number");
CREATE UNIQUE INDEX IF NOT EXISTS "payout_attempts_request_attempt_key" ON "payout_submission_attempts" ("payout_request_id","attempt_number");

CREATE TABLE IF NOT EXISTS "payout_provider_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "provider" varchar(32) NOT NULL,
  "provider_event_id" varchar(200) NOT NULL,
  "payout_request_id" uuid REFERENCES "payout_requests"("id") ON DELETE SET NULL,
  "provider_payout_id" varchar(200),
  "normalized_type" varchar(24) NOT NULL,
  "event_ts" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processing_state" varchar(12) NOT NULL DEFAULT 'PENDING',
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "payout_provider_events_key" ON "payout_provider_events" ("provider","provider_event_id");
CREATE INDEX IF NOT EXISTS "payout_provider_events_request_idx" ON "payout_provider_events" ("payout_request_id");
CREATE INDEX IF NOT EXISTS "payout_provider_events_payout_idx" ON "payout_provider_events" ("provider","provider_payout_id");

CREATE TABLE IF NOT EXISTS "payout_reconciliation_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "payout_request_id" uuid NOT NULL REFERENCES "payout_requests"("id") ON DELETE CASCADE,
  "provider" varchar(32) NOT NULL,
  "expected_state" varchar(24),
  "provider_state" varchar(24),
  "mismatch_type" varchar(32) NOT NULL DEFAULT 'NONE',
  "resolution" varchar(24) NOT NULL DEFAULT 'NO_ACTION',
  "auto_resolved" boolean NOT NULL DEFAULT false,
  "detail" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "payout_recon_request_idx" ON "payout_reconciliation_records" ("payout_request_id","created_at");
CREATE INDEX IF NOT EXISTS "payout_recon_mismatch_idx" ON "payout_reconciliation_records" ("organization_id","mismatch_type");

CREATE TABLE IF NOT EXISTS "payout_operations_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "production_enabled" boolean NOT NULL DEFAULT false,
  "provider" varchar(32),
  "reserve_threshold_micros" bigint NOT NULL DEFAULT 0,
  "max_single_auto_micros" bigint,
  "max_aggregate_auto_per_day_micros" bigint,
  "circuit_breaker_open" boolean NOT NULL DEFAULT false,
  "recon_stale_threshold_seconds" integer NOT NULL DEFAULT 900,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS "payout_ops_config_org_key" ON "payout_operations_config" ("organization_id");

CREATE TABLE IF NOT EXISTS "payout_circuit_breaker_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "action" varchar(8) NOT NULL,
  "reason" varchar(300),
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "payout_breaker_events_org_idx" ON "payout_circuit_breaker_events" ("organization_id","created_at");
