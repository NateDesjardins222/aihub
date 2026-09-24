-- Milestone 5 — Trader Personal Risk Controls V1.
-- Additive and safe: new tables + one new column (defaulted), no back-fill, no
-- destructive change. Personal controls can only make an account MORE
-- restrictive; firm rules remain authoritative.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "opened_exposure" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "trader_risk_controls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "control_type" varchar(32) NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "mode" varchar(12) NOT NULL DEFAULT 'FLEXIBLE',
  "value_micros" bigint,
  "value_int" integer,
  "window_start" varchar(5),
  "window_end" varchar(5),
  "sessions_json" jsonb,
  "locked_at" timestamptz,
  "locked_trading_day" date,
  "version" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "trader_risk_controls_account_type_key" ON "trader_risk_controls" ("account_id", "control_type");
CREATE INDEX IF NOT EXISTS "trader_risk_controls_account_idx" ON "trader_risk_controls" ("account_id");

CREATE TABLE IF NOT EXISTS "trader_risk_control_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "control_type" varchar(32) NOT NULL,
  "action" varchar(24) NOT NULL,
  "old_state" jsonb,
  "new_state" jsonb,
  "mode" varchar(12),
  "effective_trading_day" date,
  "actor_user_id" uuid,
  "source" varchar(12) NOT NULL DEFAULT 'TRADER',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "trader_risk_control_events_account_idx" ON "trader_risk_control_events" ("account_id", "created_at");

CREATE TABLE IF NOT EXISTS "trader_risk_day_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "trade_date" date NOT NULL,
  "opening_trade_count" integer NOT NULL DEFAULT 0,
  "contracts_opened" integer NOT NULL DEFAULT 0,
  "consecutive_losses" integer NOT NULL DEFAULT 0,
  "last_loss_closed_at_ms" bigint,
  "day_high_equity_micros" bigint,
  "realized_net_pnl_micros" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "trader_risk_day_state_account_date_key" ON "trader_risk_day_state" ("account_id", "trade_date");
