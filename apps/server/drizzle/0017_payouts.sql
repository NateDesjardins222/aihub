-- Happy Trader Funding — Payout Engine V1 + Economics Simulator V1.
--
-- Additive and non-destructive. No money leaves the firm: PROCESSING/PAID are
-- operator/mock transitions. The payout ledger is append-only, enforced by a
-- trigger (mirrors auditLog). The economics tables are owner-only synthetic
-- storage with no FKs into trader/account data.

CREATE TABLE IF NOT EXISTS "payout_cycles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "model" varchar(8) NOT NULL,
  "ordinal" integer NOT NULL,
  "started_on" date,
  "daily_mode_unlocked" boolean NOT NULL DEFAULT false,
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "payout_cycles_account_ordinal" ON "payout_cycles" ("account_id", "ordinal");
CREATE INDEX IF NOT EXISTS "payout_cycles_org_idx" ON "payout_cycles" ("organization_id");

CREATE TABLE IF NOT EXISTS "payout_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "product_version_id" uuid REFERENCES "account_profile_versions"("id"),
  "cycle_id" uuid REFERENCES "payout_cycles"("id"),
  "state" varchar(20) NOT NULL DEFAULT 'REQUESTED',
  "requested_gross_micros" bigint NOT NULL,
  "gross_eligible_micros" bigint,
  "trader_share_micros" bigint,
  "firm_share_micros" bigint,
  "fees_micros" bigint NOT NULL DEFAULT 0,
  "balance_adjustment_micros" bigint,
  "protected_buffer_micros" bigint,
  "withdrawable_before_micros" bigint,
  "eligibility_snapshot" jsonb,
  "payout_ordinal" integer NOT NULL DEFAULT 1,
  "hold_kind" varchar(16),
  "reason" text,
  "idempotency_key" varchar(200),
  "version" integer NOT NULL DEFAULT 0,
  "requested_by_user_id" uuid REFERENCES "users"("id"),
  "decided_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "paid_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "payout_requests_idem_key" ON "payout_requests" ("organization_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "payout_requests_org_state_idx" ON "payout_requests" ("organization_id", "state");
CREATE INDEX IF NOT EXISTS "payout_requests_account_idx" ON "payout_requests" ("account_id");

CREATE TABLE IF NOT EXISTS "payout_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "payout_request_id" uuid NOT NULL REFERENCES "payout_requests"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "entry_type" varchar(16) NOT NULL,
  "amount_micros" bigint NOT NULL,
  "balance_before_micros" bigint NOT NULL,
  "balance_after_micros" bigint NOT NULL,
  "gross_eligible_micros" bigint,
  "trader_share_micros" bigint,
  "firm_share_micros" bigint,
  "protected_buffer_micros" bigint,
  "product_version_id" uuid REFERENCES "account_profile_versions"("id"),
  "meta" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
-- The debit/settlement of a request happens at most once: a duplicate approval
-- or provider webhook cannot insert a second money event for the same entry.
CREATE UNIQUE INDEX IF NOT EXISTS "payout_ledger_request_entry" ON "payout_ledger" ("payout_request_id", "entry_type");
CREATE INDEX IF NOT EXISTS "payout_ledger_account_idx" ON "payout_ledger" ("account_id");
CREATE INDEX IF NOT EXISTS "payout_ledger_org_idx" ON "payout_ledger" ("organization_id");

-- Append-only: the payout ledger is the money's tamper-resistant record.
CREATE OR REPLACE FUNCTION "payout_ledger_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payout_ledger is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "payout_ledger_no_update" ON "payout_ledger";
CREATE TRIGGER "payout_ledger_no_update" BEFORE UPDATE OR DELETE ON "payout_ledger"
  FOR EACH ROW EXECUTE FUNCTION "payout_ledger_immutable"();

CREATE TABLE IF NOT EXISTS "economics_scenarios" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" varchar(120) NOT NULL,
  "base_scenario" varchar(40),
  "assumptions" jsonb NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "economics_scenarios_org_idx" ON "economics_scenarios" ("organization_id");

CREATE TABLE IF NOT EXISTS "economics_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "scenario_id" uuid REFERENCES "economics_scenarios"("id"),
  "seed" bigint NOT NULL,
  "purchases" integer NOT NULL,
  "assumptions" jsonb NOT NULL,
  "results" jsonb NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "economics_runs_org_idx" ON "economics_runs" ("organization_id");
