-- Milestone 3: execution engine state.
--
-- These are SEMANTIC changes, not renames. `avg_entry_ticks` and
-- `avg_fill_ticks` held float averages; they are replaced by the integer
-- quantities those averages are derived from, because a float average
-- accumulates rounding error across partial fills and feeds straight into
-- realized P&L.

-- Orders ---------------------------------------------------------------------
ALTER TABLE "orders" DROP COLUMN IF EXISTS "avg_fill_ticks";
ALTER TABLE "orders" ADD COLUMN "fill_notional_micros" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "orders" ADD COLUMN "stop_triggered" boolean DEFAULT false NOT NULL;
ALTER TABLE "orders" ADD COLUMN "has_rested" boolean DEFAULT false NOT NULL;
ALTER TABLE "orders" ADD COLUMN "eligible_at" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "orders" ADD COLUMN "trading_date" date;

-- Positions ------------------------------------------------------------------
ALTER TABLE "positions" DROP COLUMN IF EXISTS "avg_entry_ticks";
ALTER TABLE "positions" ADD COLUMN "cost_basis_micros" bigint DEFAULT 0 NOT NULL;

-- Trades ---------------------------------------------------------------------
-- Entry and exit are weighted averages of tick prices and are fractional by
-- nature, so they are stored scaled by 1e6 rather than as float4.
ALTER TABLE "trades" DROP COLUMN IF EXISTS "entry_ticks";
ALTER TABLE "trades" DROP COLUMN IF EXISTS "exit_ticks";
ALTER TABLE "trades" ADD COLUMN "entry_ticks_scaled" bigint NOT NULL DEFAULT 0;
ALTER TABLE "trades" ADD COLUMN "exit_ticks_scaled" bigint NOT NULL DEFAULT 0;
ALTER TABLE "trades" ALTER COLUMN "entry_ticks_scaled" DROP DEFAULT;
ALTER TABLE "trades" ALTER COLUMN "exit_ticks_scaled" DROP DEFAULT;

-- Accounts -------------------------------------------------------------------
ALTER TABLE "accounts" ADD COLUMN "simulation_environment" jsonb;

-- Working orders are matched per symbol on every market event, so the hot path
-- is "open orders for this symbol".
CREATE INDEX IF NOT EXISTS "orders_working_idx" ON "orders" ("symbol", "status")
  WHERE "status" IN ('WORKING', 'PARTIALLY_FILLED');
