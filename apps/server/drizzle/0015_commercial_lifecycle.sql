-- Commercial Account Lifecycle V1.
--
-- Provider-independent: a commercial order (a purchase or an admin grant) makes
-- an entitlement, which provisions exactly one account; a passed evaluation
-- records an immutable qualification and can produce exactly one funded-sim
-- account linked back to it. No money moves. All additive and non-destructive:
-- existing accounts carry NULL in the new columns and behave as before.

ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "source_qualification_id" uuid;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "source_account_id" uuid;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "funded_profile_version_id" uuid
  REFERENCES "account_profile_versions"("id");

CREATE TABLE IF NOT EXISTS "commercial_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "product_version_id" uuid NOT NULL REFERENCES "account_profile_versions"("id"),
  "source" varchar(24) NOT NULL,
  "external_provider" varchar(40),
  "external_reference" varchar(200),
  "status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "amount_micros" bigint,
  "currency" varchar(8),
  "idempotency_key" varchar(200),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "commercial_orders_org_idx" ON "commercial_orders" ("organization_id");
CREATE INDEX IF NOT EXISTS "commercial_orders_user_idx" ON "commercial_orders" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_orders_idem_key" ON "commercial_orders" ("organization_id", "idempotency_key");

CREATE TABLE IF NOT EXISTS "entitlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "commercial_order_id" uuid REFERENCES "commercial_orders"("id"),
  "product_version_id" uuid NOT NULL REFERENCES "account_profile_versions"("id"),
  "kind" varchar(16) NOT NULL,
  "source" varchar(24) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'GRANTED',
  "consumed_by_account_id" uuid REFERENCES "accounts"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "consumed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "entitlements_org_idx" ON "entitlements" ("organization_id");
CREATE INDEX IF NOT EXISTS "entitlements_user_idx" ON "entitlements" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "entitlements_order_kind_key" ON "entitlements" ("commercial_order_id", "kind");

CREATE TABLE IF NOT EXISTS "account_qualifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "lifecycle_id" uuid REFERENCES "account_lifecycles"("id"),
  "product_version_id" uuid REFERENCES "account_profile_versions"("id"),
  "evidence" jsonb NOT NULL,
  "balance_micros" bigint NOT NULL,
  "qualified_at" timestamptz NOT NULL DEFAULT now(),
  "funding_state" varchar(20) NOT NULL DEFAULT 'ELIGIBLE',
  "funded_account_id" uuid REFERENCES "accounts"("id"),
  "approved_by_user_id" uuid REFERENCES "users"("id"),
  "approved_at" timestamptz,
  "decline_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "account_qualifications_life_key" ON "account_qualifications" ("account_id", "lifecycle_id");
CREATE INDEX IF NOT EXISTS "account_qualifications_org_state_idx" ON "account_qualifications" ("organization_id", "funding_state");
