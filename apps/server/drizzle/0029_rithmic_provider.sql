-- Milestone 9: Rithmic / external-provider durable infrastructure.
-- Reuses M4 external_orders / external_execution_events / provider_account_mappings.

CREATE TABLE IF NOT EXISTS "provider_discovered_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "provider" varchar(24) NOT NULL,
  "environment" varchar(16) NOT NULL,
  "fcm_id" varchar(64),
  "ib_id" varchar(64),
  "account_id" varchar(120) NOT NULL,
  "display_name" varchar(160),
  "currency" varchar(8),
  "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
  "last_seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "provider_discovered_accounts_key" ON "provider_discovered_accounts" ("provider","environment","account_id");
CREATE INDEX IF NOT EXISTS "provider_discovered_accounts_org_idx" ON "provider_discovered_accounts" ("organization_id");

CREATE TABLE IF NOT EXISTS "provider_connection_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "provider" varchar(24) NOT NULL,
  "plant" varchar(16) NOT NULL,
  "event" varchar(24) NOT NULL,
  "detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "provider_connection_events_idx" ON "provider_connection_events" ("provider","created_at");

CREATE TABLE IF NOT EXISTS "provider_reconciliation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "provider" varchar(24) NOT NULL,
  "scope" varchar(16) NOT NULL,
  "trigger" varchar(16) NOT NULL,
  "matched" integer NOT NULL DEFAULT 0,
  "mismatch" integer NOT NULL DEFAULT 0,
  "unknown" integer NOT NULL DEFAULT 0,
  "requires_review" integer NOT NULL DEFAULT 0,
  "auto_resolved" integer NOT NULL DEFAULT 0,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "provider_reconciliation_runs_idx" ON "provider_reconciliation_runs" ("provider","created_at");
