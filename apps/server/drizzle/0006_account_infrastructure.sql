-- Account infrastructure: organisations, roles, versioned products, account
-- lifecycles, an append-only audit log and an event outbox.
--
-- Nothing here changes how an order is matched or how P&L is computed. Every
-- existing row is backfilled so the platform behaves exactly as it did before,
-- with the new structure underneath it.

-- ---------------------------------------------------------------------------
-- Organisations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(40) NOT NULL,
  "name" varchar(120) NOT NULL,
  "status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
  "branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_key" ON "organizations" ("slug");

-- Atlas is a row in this table, not the assumption behind every other one.
INSERT INTO "organizations" ("slug", "name")
VALUES ('atlas', 'Atlas Futures')
ON CONFLICT ("slug") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Users: roles, status, tenancy
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" varchar(16) DEFAULT 'TRADER' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" varchar(16) DEFAULT 'ACTIVE' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp with time zone;

-- An existing administrator keeps their access under the new scheme.
UPDATE "users" SET "role" = 'ADMIN' WHERE "is_admin" = true AND "role" = 'TRADER';
UPDATE "users" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'atlas')
WHERE "organization_id" IS NULL;

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "users_org_idx" ON "users" ("organization_id");

-- ---------------------------------------------------------------------------
-- Products: a profile is the name, a version is the terms
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "account_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "key" varchar(60) NOT NULL,
  "name" varchar(120) NOT NULL,
  "account_type" varchar(20) NOT NULL,
  "status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "account_profiles_org_key" ON "account_profiles" ("organization_id", "key");

CREATE TABLE IF NOT EXISTS "account_profile_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "account_profiles"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "config" jsonb NOT NULL,
  "notes" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "account_profile_versions_key" ON "account_profile_versions" ("profile_id", "version");

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

-- The number a trader says out loud. A sequence, so two concurrent
-- provisioning calls cannot produce the same one.
CREATE SEQUENCE IF NOT EXISTS "account_public_id_seq" START 1000;

ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "public_id" varchar(24);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "profile_version_id" uuid;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "instrument_limits" jsonb;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "external_metadata" jsonb;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "current_lifecycle_id" uuid;

UPDATE "accounts"
SET "public_id" = 'SIM-' || lpad(nextval('account_public_id_seq')::text, 6, '0')
WHERE "public_id" IS NULL;

UPDATE "accounts" SET "organization_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'atlas')
WHERE "organization_id" IS NULL;

-- An account that has been traded was activated when it was created; there was
-- no pending state before this migration.
UPDATE "accounts" SET "activated_at" = "created_at" WHERE "activated_at" IS NULL;

ALTER TABLE "accounts"
  ALTER COLUMN "public_id" SET DEFAULT 'SIM-' || lpad(nextval('account_public_id_seq')::text, 6, '0');
ALTER TABLE "accounts" ALTER COLUMN "public_id" SET NOT NULL;

-- An account provisioned from a profile version carries its terms there, so the
-- old template reference is no longer mandatory.
ALTER TABLE "accounts" ALTER COLUMN "rule_template_id" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "accounts" ADD CONSTRAINT "accounts_profile_version_id_fk"
    FOREIGN KEY ("profile_version_id") REFERENCES "account_profile_versions"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "accounts_public_id_key" ON "accounts" ("public_id");
CREATE INDEX IF NOT EXISTS "accounts_org_idx" ON "accounts" ("organization_id");
CREATE INDEX IF NOT EXISTS "accounts_status_idx" ON "accounts" ("status");

-- ---------------------------------------------------------------------------
-- Lifecycles: what a reset closes and opens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "account_lifecycles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "profile_version_id" uuid REFERENCES "account_profile_versions"("id"),
  "starting_balance_micros" bigint NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "end_reason" varchar(24),
  "final_balance_micros" bigint,
  "final_status" varchar(20),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "account_lifecycles_seq_key" ON "account_lifecycles" ("account_id", "seq");
CREATE INDEX IF NOT EXISTS "account_lifecycles_account_idx" ON "account_lifecycles" ("account_id", "started_at");

-- Every existing account is in its first life, which began when it was created.
INSERT INTO "account_lifecycles" ("account_id", "seq", "starting_balance_micros", "started_at")
SELECT a."id", 1, a."starting_balance_micros", a."created_at"
FROM "accounts" a
WHERE NOT EXISTS (SELECT 1 FROM "account_lifecycles" l WHERE l."account_id" = a."id");

UPDATE "accounts" a
SET "current_lifecycle_id" = l."id"
FROM "account_lifecycles" l
WHERE l."account_id" = a."id" AND l."seq" = 1 AND a."current_lifecycle_id" IS NULL;

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash chained
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "actor_type" varchar(16) NOT NULL,
  "actor_user_id" uuid,
  "actor_label" varchar(120),
  "subject_type" varchar(24) NOT NULL,
  "subject_id" uuid,
  "account_id" uuid,
  "user_id" uuid,
  "action" varchar(60) NOT NULL,
  "prev_state" jsonb,
  "new_state" jsonb,
  "reason" text,
  "context" jsonb,
  "request_id" varchar(64),
  "ip" varchar(64),
  "prev_hash" varchar(64),
  "hash" varchar(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "audit_log_org_idx" ON "audit_log" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_log_account_idx" ON "audit_log" ("account_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_log_user_idx" ON "audit_log" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log" ("action", "created_at");

-- The audit log is evidence. Ordinary application code must not be able to
-- rewrite it - not by a careless UPDATE, not by a cascade, not by a migration
-- that means well. The database refuses.
CREATE OR REPLACE FUNCTION "atlas_audit_log_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_log_no_update" ON "audit_log";
CREATE TRIGGER "audit_log_no_update" BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "atlas_audit_log_immutable"();

DROP TRIGGER IF EXISTS "audit_log_no_delete" ON "audit_log";
CREATE TRIGGER "audit_log_no_delete" BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "atlas_audit_log_immutable"();

-- A published product version is equally final: an account pinned to it must
-- keep the terms it was sold, so the row cannot be edited afterwards.
CREATE OR REPLACE FUNCTION "atlas_profile_version_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'account_profile_versions is append-only: publish a new version instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "profile_versions_no_update" ON "account_profile_versions";
CREATE TRIGGER "profile_versions_no_update" BEFORE UPDATE ON "account_profile_versions"
  FOR EACH ROW EXECUTE FUNCTION "atlas_profile_version_immutable"();

-- ---------------------------------------------------------------------------
-- Outbox and provisioning
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "domain_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "type" varchar(60) NOT NULL,
  "account_id" uuid,
  "user_id" uuid,
  "payload" jsonb NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "domain_events_type_idx" ON "domain_events" ("type", "occurred_at");
CREATE INDEX IF NOT EXISTS "domain_events_undelivered_idx" ON "domain_events" ("delivered_at", "occurred_at");
CREATE INDEX IF NOT EXISTS "domain_events_account_idx" ON "domain_events" ("account_id", "occurred_at");

CREATE TABLE IF NOT EXISTS "provisioning_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "idempotency_key" varchar(120) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "provisioning_requests_key" ON "provisioning_requests" ("organization_id", "idempotency_key");

CREATE TABLE IF NOT EXISTS "provisioning_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "name" varchar(80) NOT NULL,
  "prefix" varchar(16) NOT NULL,
  "key_hash" text NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "provisioning_keys_hash_key" ON "provisioning_keys" ("key_hash");
CREATE INDEX IF NOT EXISTS "provisioning_keys_org_idx" ON "provisioning_keys" ("organization_id");

-- ---------------------------------------------------------------------------
-- Backfill: one product profile per existing rule template
-- ---------------------------------------------------------------------------
--
-- The templates become version 1 of a profile with the same terms, so an
-- account provisioned tomorrow from a profile and an account created yesterday
-- from a template are evaluated by exactly the same numbers.

INSERT INTO "account_profiles" ("organization_id", "key", "name", "account_type", "description")
SELECT
  (SELECT "id" FROM "organizations" WHERE "slug" = 'atlas'),
  regexp_replace(lower(regexp_replace(t."name", '^Atlas ', '')), '[^a-z0-9]+', '-', 'g'),
  regexp_replace(t."name", '^Atlas ', ''),
  t."account_type",
  'Imported from rule template ' || t."name"
FROM "rule_templates" t
ON CONFLICT ("organization_id", "key") DO NOTHING;

INSERT INTO "account_profile_versions" ("profile_id", "version", "config", "notes")
SELECT
  p."id",
  1,
  jsonb_build_object(
    'rules', jsonb_build_object(
      'accountSizeMicros', t."account_size_micros",
      'profitTargetMicros', t."profit_target_micros",
      'maxLossMicros', t."max_loss_micros",
      'drawdownType', t."drawdown_type",
      'trailingLockAtMicros', t."trailing_lock_at_micros",
      'dailyLossLimitMicros', t."daily_loss_limit_micros",
      'dailyLossPolicy', t."daily_loss_policy",
      'consistencyFormula', t."consistency_formula",
      'consistencyThreshold', t."consistency_threshold",
      'minTradingDays', t."min_trading_days",
      'minWinningDays', t."min_winning_days",
      'maxTradingDays', t."max_trading_days",
      'minDailyPnlToCountMicros', t."min_daily_pnl_to_count_micros",
      'minWinningDayPnlMicros', t."min_winning_day_pnl_micros",
      'maxContracts', t."max_contracts",
      'microsCountAsFraction', t."micros_count_as_fraction",
      'flattenOnBreach', t."flatten_on_breach"
    ),
    'instruments', jsonb_build_object('allowed', NULL, 'maxContracts', t."max_contracts"),
    'display', jsonb_build_object('startingBalanceMicros', t."account_size_micros"),
    'payoutRules', t."payout_rules"
  ),
  'Imported from rule template'
FROM "rule_templates" t
JOIN "account_profiles" p
  ON p."key" = regexp_replace(lower(regexp_replace(t."name", '^Atlas ', '')), '[^a-z0-9]+', '-', 'g')
WHERE NOT EXISTS (
  SELECT 1 FROM "account_profile_versions" v WHERE v."profile_id" = p."id" AND v."version" = 1
);

-- Existing accounts are pinned to the imported version of their own product.
UPDATE "accounts" a
SET "profile_version_id" = v."id"
FROM "rule_templates" t
JOIN "account_profiles" p
  ON p."key" = regexp_replace(lower(regexp_replace(t."name", '^Atlas ', '')), '[^a-z0-9]+', '-', 'g')
JOIN "account_profile_versions" v ON v."profile_id" = p."id" AND v."version" = 1
WHERE a."rule_template_id" = t."id" AND a."profile_version_id" IS NULL;

UPDATE "account_lifecycles" l
SET "profile_version_id" = a."profile_version_id"
FROM "accounts" a
WHERE l."account_id" = a."id" AND l."profile_version_id" IS NULL;
