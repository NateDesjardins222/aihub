-- Operational read model + a durable delivery outbox.
--
-- account_projections is a derived, rebuildable snapshot of each account's
-- AUTHORITATIVE financial state (never a source of truth). Owner and trader
-- reads hit it instead of recomputing every account from scratch; equity and
-- unrealized P&L are applied from live marks at read time, so the projection
-- never stores a stale valuation.
--
-- outbox_events is the transactional outbox the delivery worker drains with
-- FOR UPDATE SKIP LOCKED. A financial mutation enqueues one row in its own
-- transaction, so an event exists whenever the state change committed.

CREATE TABLE IF NOT EXISTS "account_projections" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "organization_id" uuid,
  "state_version" bigint NOT NULL,
  "status" varchar(20) NOT NULL,
  "admin_hold" varchar(20),
  "rule_status" varchar(20) NOT NULL,
  "starting_balance_micros" bigint NOT NULL,
  "balance_micros" bigint NOT NULL,
  "realized_pnl_micros" bigint NOT NULL,
  "fees_micros" bigint NOT NULL,
  "high_water_mark_micros" bigint NOT NULL,
  "drawdown_floor_micros" bigint NOT NULL,
  "open_contracts" integer NOT NULL DEFAULT 0,
  "working_order_count" integer NOT NULL DEFAULT 0,
  "positions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "last_financial_mutation_at" timestamp with time zone,
  "projection_updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "consistent" boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS "account_projections_org_idx" ON "account_projections" ("organization_id");
CREATE INDEX IF NOT EXISTS "account_projections_user_idx" ON "account_projections" ("user_id");
CREATE INDEX IF NOT EXISTS "account_projections_open_idx" ON "account_projections" ("organization_id", "open_contracts");

CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "aggregate_type" varchar(20) NOT NULL DEFAULT 'ACCOUNT',
  "aggregate_id" uuid NOT NULL,
  "type" varchar(40) NOT NULL,
  "state_version" bigint,
  "payload" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "available_at" timestamp with time zone NOT NULL DEFAULT now(),
  "attempts" integer NOT NULL DEFAULT 0,
  "delivered_at" timestamp with time zone,
  "last_error" text,
  "dead_letter" boolean NOT NULL DEFAULT false
);

-- The claim query's shape: undelivered, live, due, oldest first.
CREATE INDEX IF NOT EXISTS "outbox_pending_idx"
  ON "outbox_events" ("available_at")
  WHERE "delivered_at" IS NULL AND "dead_letter" = false;
CREATE INDEX IF NOT EXISTS "outbox_aggregate_idx" ON "outbox_events" ("aggregate_id");
