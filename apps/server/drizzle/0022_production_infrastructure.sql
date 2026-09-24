-- Milestone 4 — Production Trading Infrastructure V1.
-- Additive and safe: new tables only, no back-fill, no destructive change.
-- Simulation remains the default; nothing here enables external execution.

CREATE TABLE IF NOT EXISTS "provider_account_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "execution_mode" varchar(20) NOT NULL DEFAULT 'SIMULATION',
  "execution_provider" varchar(20) NOT NULL DEFAULT 'simulation',
  "provider_environment" varchar(40),
  "provider_account_id" varchar(120),
  "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
  "mapped_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "provider_account_mappings_account_key" ON "provider_account_mappings" ("account_id");
CREATE INDEX IF NOT EXISTS "provider_account_mappings_mode_idx" ON "provider_account_mappings" ("execution_mode");

CREATE TABLE IF NOT EXISTS "external_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "atlas_order_id" uuid NOT NULL,
  "provider_order_id" varchar(120),
  "provider_account_id" varchar(120),
  "symbol" varchar(12) NOT NULL,
  "contract_code" varchar(24),
  "side" varchar(4) NOT NULL,
  "order_type" varchar(16) NOT NULL,
  "requested_qty" integer NOT NULL,
  "filled_qty" integer NOT NULL DEFAULT 0,
  "avg_fill_price" real,
  "state" varchar(20) NOT NULL DEFAULT 'PENDING_SUBMIT',
  "provider_status" varchar(60),
  "idempotency_key" varchar(120) NOT NULL,
  "submitted_at" timestamptz,
  "last_event_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "external_orders_idempotency_key" ON "external_orders" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "external_orders_account_idx" ON "external_orders" ("account_id");
CREATE INDEX IF NOT EXISTS "external_orders_atlas_order_idx" ON "external_orders" ("atlas_order_id");
CREATE INDEX IF NOT EXISTS "external_orders_provider_order_idx" ON "external_orders" ("provider_order_id");
CREATE INDEX IF NOT EXISTS "external_orders_state_idx" ON "external_orders" ("state");

CREATE TABLE IF NOT EXISTS "external_execution_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_order_id" uuid NOT NULL REFERENCES "external_orders"("id") ON DELETE CASCADE,
  "provider_order_id" varchar(120),
  "state" varchar(20) NOT NULL,
  "filled_qty" integer NOT NULL DEFAULT 0,
  "last_fill_qty" integer NOT NULL DEFAULT 0,
  "avg_fill_price" real,
  "provider_status" varchar(60),
  "event_ts" timestamptz NOT NULL,
  "dedupe_key" varchar(160),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "external_execution_events_order_idx" ON "external_execution_events" ("external_order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "external_execution_events_dedupe_key" ON "external_execution_events" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "reconciliation_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "provider_account_id" varchar(120),
  "state" varchar(30) NOT NULL DEFAULT 'IN_SYNC',
  "detail" text,
  "last_checked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_state_account_key" ON "reconciliation_state" ("account_id");

CREATE TABLE IF NOT EXISTS "market_data_entitlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "exchange" varchar(12) NOT NULL,
  "data_level" varchar(20) NOT NULL,
  "display_use" varchar(16) NOT NULL DEFAULT 'DISPLAY',
  "status" varchar(16) NOT NULL DEFAULT 'UNKNOWN',
  "provider_entitlement_ref" varchar(120),
  "effective_at" timestamptz,
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "market_data_entitlements_user_idx" ON "market_data_entitlements" ("user_id");
CREATE INDEX IF NOT EXISTS "market_data_entitlements_exchange_idx" ON "market_data_entitlements" ("exchange");

CREATE TABLE IF NOT EXISTS "provider_ops_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" varchar(40) NOT NULL,
  "role" varchar(16) NOT NULL,
  "kind" varchar(40) NOT NULL,
  "detail" text,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "provider_ops_events_provider_idx" ON "provider_ops_events" ("provider_id");
CREATE INDEX IF NOT EXISTS "provider_ops_events_occurred_idx" ON "provider_ops_events" ("occurred_at");
