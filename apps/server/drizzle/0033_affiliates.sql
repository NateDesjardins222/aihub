-- Milestone 11 — Affiliate / Partner Platform.
-- Money is micros (bigint); commission rates are basis points (integer).
-- affiliate_ledger and affiliate_agreement_acceptances are append-only.

CREATE TABLE IF NOT EXISTS "affiliate_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "version" integer NOT NULL,
  "settings" jsonb NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "effective_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_config_org_version_key" ON "affiliate_config" ("organization_id","version");
CREATE INDEX IF NOT EXISTS "affiliate_config_active_idx" ON "affiliate_config" ("organization_id","is_active");

CREATE TABLE IF NOT EXISTS "affiliates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "public_id" varchar(24) NOT NULL,
  "user_id" uuid REFERENCES "users"("id"),
  "customer_identity_id" uuid REFERENCES "customer_identities"("id"),
  "display_name" varchar(120) NOT NULL,
  "email" varchar(200) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'SUBMITTED',
  "tier" varchar(16) NOT NULL DEFAULT 'AFFILIATE',
  "tier_rate_bps" integer NOT NULL DEFAULT 1500,
  "custom_rate_bps" integer,
  "custom_rate_reason" text,
  "custom_rate_effective_at" timestamptz,
  "custom_rate_expires_at" timestamptz,
  "effective_rate_bps" integer NOT NULL DEFAULT 1500,
  "agreement_accepted_version_id" uuid,
  "needs_agreement_reacceptance" boolean NOT NULL DEFAULT false,
  "activated_at" timestamptz,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "affiliates_public_id_key" ON "affiliates" ("public_id");
CREATE UNIQUE INDEX IF NOT EXISTS "affiliates_org_user_key" ON "affiliates" ("organization_id","user_id");
CREATE INDEX IF NOT EXISTS "affiliates_org_status_idx" ON "affiliates" ("organization_id","status");
CREATE INDEX IF NOT EXISTS "affiliates_email_idx" ON "affiliates" ("email");
CREATE INDEX IF NOT EXISTS "affiliates_identity_idx" ON "affiliates" ("customer_identity_id");

CREATE TABLE IF NOT EXISTS "affiliate_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE CASCADE,
  "status" varchar(32) NOT NULL DEFAULT 'SUBMITTED',
  "full_name" varchar(160) NOT NULL,
  "email" varchar(200) NOT NULL,
  "brand_name" varchar(160),
  "primary_platform" varchar(60),
  "profile_url" varchar(500),
  "audience_size" varchar(40),
  "audience_description" text,
  "promotion_plan" text,
  "country" varchar(80),
  "extra_links" jsonb,
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "reviewed_by_user_id" uuid REFERENCES "users"("id"),
  "reviewed_at" timestamptz,
  "review_notes" text,
  "decline_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "affiliate_applications_affiliate_idx" ON "affiliate_applications" ("affiliate_id");
CREATE INDEX IF NOT EXISTS "affiliate_applications_org_status_idx" ON "affiliate_applications" ("organization_id","status");

CREATE TABLE IF NOT EXISTS "affiliate_agreement_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE CASCADE,
  "agreement_version_id" uuid NOT NULL REFERENCES "agreement_versions"("id"),
  "content_hash" varchar(64) NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  "ip" varchar(64),
  "user_agent" varchar(400),
  "session_ref" varchar(80),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "affiliate_agreement_acceptances_affiliate_idx" ON "affiliate_agreement_acceptances" ("affiliate_id");
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_agreement_acceptances_unique" ON "affiliate_agreement_acceptances" ("affiliate_id","agreement_version_id");

CREATE TABLE IF NOT EXISTS "affiliate_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE CASCADE,
  "code" varchar(40) NOT NULL,
  "code_canonical" varchar(40) NOT NULL,
  "kind" varchar(16) NOT NULL DEFAULT 'PRIMARY',
  "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
  "discount_bps" integer,
  "campaign_label" varchar(120),
  "alias_of_code_id" uuid,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "disabled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_codes_org_canonical_key" ON "affiliate_codes" ("organization_id","code_canonical");
CREATE INDEX IF NOT EXISTS "affiliate_codes_affiliate_idx" ON "affiliate_codes" ("affiliate_id");
CREATE INDEX IF NOT EXISTS "affiliate_codes_status_idx" ON "affiliate_codes" ("organization_id","status");

CREATE TABLE IF NOT EXISTS "affiliate_clicks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE CASCADE,
  "code_id" uuid REFERENCES "affiliate_codes"("id"),
  "referral_slug" varchar(40) NOT NULL,
  "session_ref" varchar(80) NOT NULL,
  "landing_path" varchar(400),
  "campaign" jsonb,
  "ip_hash" varchar(64),
  "user_agent" varchar(400),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "affiliate_clicks_affiliate_idx" ON "affiliate_clicks" ("affiliate_id");
CREATE INDEX IF NOT EXISTS "affiliate_clicks_session_idx" ON "affiliate_clicks" ("session_ref");
CREATE INDEX IF NOT EXISTS "affiliate_clicks_created_idx" ON "affiliate_clicks" ("created_at");

CREATE TABLE IF NOT EXISTS "affiliate_touches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "session_ref" varchar(80) NOT NULL,
  "first_touch_affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id"),
  "first_touch_code_id" uuid REFERENCES "affiliate_codes"("id"),
  "first_touch_at" timestamptz NOT NULL DEFAULT now(),
  "last_touch_affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id"),
  "last_touch_code_id" uuid REFERENCES "affiliate_codes"("id"),
  "last_touch_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_touches_session_key" ON "affiliate_touches" ("organization_id","session_ref");
CREATE INDEX IF NOT EXISTS "affiliate_touches_expires_idx" ON "affiliate_touches" ("expires_at");

CREATE TABLE IF NOT EXISTS "affiliate_conversions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id"),
  "code_id" uuid REFERENCES "affiliate_codes"("id"),
  "commercial_order_id" uuid NOT NULL REFERENCES "commercial_orders"("id") ON DELETE CASCADE,
  "customer_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "customer_identity_id" uuid REFERENCES "customer_identities"("id"),
  "source" varchar(16) NOT NULL,
  "first_touch_affiliate_id" uuid REFERENCES "affiliates"("id"),
  "last_touch_affiliate_id" uuid REFERENCES "affiliates"("id"),
  "final_attribution_reason" varchar(40) NOT NULL,
  "qualified_revenue_micros" bigint NOT NULL,
  "discount_micros" bigint,
  "product_version_id" uuid REFERENCES "account_profile_versions"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_conversions_order_key" ON "affiliate_conversions" ("commercial_order_id");
CREATE INDEX IF NOT EXISTS "affiliate_conversions_affiliate_idx" ON "affiliate_conversions" ("affiliate_id");
CREATE INDEX IF NOT EXISTS "affiliate_conversions_created_idx" ON "affiliate_conversions" ("created_at");

CREATE TABLE IF NOT EXISTS "affiliate_commissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id"),
  "conversion_id" uuid NOT NULL REFERENCES "affiliate_conversions"("id") ON DELETE CASCADE,
  "commercial_order_id" uuid NOT NULL REFERENCES "commercial_orders"("id") ON DELETE CASCADE,
  "customer_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "qualified_revenue_micros" bigint NOT NULL,
  "rate_bps" integer NOT NULL,
  "rate_source" varchar(24) NOT NULL,
  "tier_at_event" varchar(16) NOT NULL,
  "commission_micros" bigint NOT NULL,
  "currency" varchar(8) NOT NULL DEFAULT 'USD',
  "product_version_id" uuid REFERENCES "account_profile_versions"("id"),
  "config_version" integer NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'TRACKED',
  "maturity_at" timestamptz NOT NULL,
  "matured_at" timestamptz,
  "paid_at" timestamptz,
  "reversed_at" timestamptz,
  "reversal_reason" varchar(200),
  "hold_reason" varchar(200),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_commissions_conversion_key" ON "affiliate_commissions" ("conversion_id");
CREATE INDEX IF NOT EXISTS "affiliate_commissions_affiliate_status_idx" ON "affiliate_commissions" ("affiliate_id","status");
CREATE INDEX IF NOT EXISTS "affiliate_commissions_maturity_idx" ON "affiliate_commissions" ("status","maturity_at");
CREATE INDEX IF NOT EXISTS "affiliate_commissions_order_idx" ON "affiliate_commissions" ("commercial_order_id");

CREATE TABLE IF NOT EXISTS "affiliate_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id"),
  "entry_type" varchar(32) NOT NULL,
  "amount_micros" bigint NOT NULL,
  "currency" varchar(8) NOT NULL DEFAULT 'USD',
  "commission_id" uuid REFERENCES "affiliate_commissions"("id"),
  "payout_id" uuid,
  "commercial_order_id" uuid REFERENCES "commercial_orders"("id"),
  "reason_code" varchar(40),
  "explanation" text,
  "actor_user_id" uuid REFERENCES "users"("id"),
  "correlation_id" varchar(80),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "affiliate_ledger_affiliate_idx" ON "affiliate_ledger" ("affiliate_id");
CREATE INDEX IF NOT EXISTS "affiliate_ledger_type_idx" ON "affiliate_ledger" ("entry_type");
CREATE INDEX IF NOT EXISTS "affiliate_ledger_created_idx" ON "affiliate_ledger" ("created_at");

CREATE TABLE IF NOT EXISTS "affiliate_payouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id"),
  "public_ref" varchar(24) NOT NULL,
  "amount_micros" bigint NOT NULL,
  "currency" varchar(8) NOT NULL DEFAULT 'USD',
  "status" varchar(16) NOT NULL DEFAULT 'REQUESTED',
  "provider" varchar(40),
  "method" varchar(40),
  "external_reference" varchar(200),
  "note" text,
  "evidence_ref" varchar(200),
  "requested_by_user_id" uuid REFERENCES "users"("id"),
  "approved_by_user_id" uuid REFERENCES "users"("id"),
  "paid_at" timestamptz,
  "failure_reason" varchar(200),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "affiliate_payouts_public_ref_key" ON "affiliate_payouts" ("public_ref");
CREATE INDEX IF NOT EXISTS "affiliate_payouts_affiliate_status_idx" ON "affiliate_payouts" ("affiliate_id","status");

CREATE TABLE IF NOT EXISTS "affiliate_tier_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE CASCADE,
  "prior_tier" varchar(16),
  "new_tier" varchar(16) NOT NULL,
  "qualification_period" varchar(7),
  "qualified_revenue_micros" bigint,
  "effective_at" timestamptz NOT NULL DEFAULT now(),
  "reason" varchar(200),
  "automatic" boolean NOT NULL DEFAULT true,
  "staff_actor_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "affiliate_tier_history_affiliate_idx" ON "affiliate_tier_history" ("affiliate_id");

CREATE TABLE IF NOT EXISTS "affiliate_rate_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE CASCADE,
  "prior_rate_bps" integer,
  "new_rate_bps" integer NOT NULL,
  "source" varchar(24) NOT NULL,
  "reason" text,
  "effective_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "staff_actor_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "affiliate_rate_history_affiliate_idx" ON "affiliate_rate_history" ("affiliate_id");

CREATE TABLE IF NOT EXISTS "affiliate_risk_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "affiliate_id" uuid NOT NULL REFERENCES "affiliates"("id") ON DELETE CASCADE,
  "signal_type" varchar(48) NOT NULL,
  "severity" varchar(16) NOT NULL DEFAULT 'INFO',
  "detail" jsonb,
  "status" varchar(16) NOT NULL DEFAULT 'OPEN',
  "reviewed_by_user_id" uuid REFERENCES "users"("id"),
  "reviewed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "affiliate_risk_signals_affiliate_idx" ON "affiliate_risk_signals" ("affiliate_id");
CREATE INDEX IF NOT EXISTS "affiliate_risk_signals_status_idx" ON "affiliate_risk_signals" ("organization_id","status");

-- Append-only guards: the affiliate ledger and agreement acceptances are
-- financial/evidentiary records that must never be rewritten.
CREATE OR REPLACE FUNCTION "affiliate_block_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "affiliate_ledger_no_update" ON "affiliate_ledger";
CREATE TRIGGER "affiliate_ledger_no_update" BEFORE UPDATE OR DELETE ON "affiliate_ledger"
  FOR EACH ROW EXECUTE FUNCTION "affiliate_block_mutation"();

DROP TRIGGER IF EXISTS "affiliate_agreement_acceptances_no_update" ON "affiliate_agreement_acceptances";
CREATE TRIGGER "affiliate_agreement_acceptances_no_update" BEFORE UPDATE OR DELETE ON "affiliate_agreement_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "affiliate_block_mutation"();
