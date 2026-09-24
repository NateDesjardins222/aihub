-- Happy Trader Funding — Customer Portal + Trader Analytics + Account Lifecycle
-- UX V1. Additive and non-destructive.
--
-- accounts: nickname (presentation-only, never authoritative), reset linkage
-- (a reset preserves the failed account), and an archive flag (presentation
-- preference only). customer_identities: a safe public display name for
-- certificates and a global achievements-visibility opt-in. certificates and
-- achievements: event-driven, idempotent (unique dedupe_key), privacy-safe.

ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "nickname" varchar(60);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "reset_of_account_id" uuid;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;

ALTER TABLE "customer_identities" ADD COLUMN IF NOT EXISTS "preferred_display_name" varchar(80);
ALTER TABLE "customer_identities" ADD COLUMN IF NOT EXISTS "achievements_public" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "certificates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "certificate_public_id" varchar(24) NOT NULL,
  "verification_token" varchar(48) NOT NULL,
  "type" varchar(24) NOT NULL,
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "account_id" uuid REFERENCES "accounts"("id"),
  "public_display_name" varchar(80) NOT NULL,
  "amount_micros" bigint,
  "status" varchar(16) NOT NULL DEFAULT 'ISSUED',
  "revoked_reason" text,
  "template_version" varchar(24) NOT NULL DEFAULT 'v1',
  "dedupe_key" varchar(200) NOT NULL,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "certificates_dedupe_key" ON "certificates" ("organization_id", "dedupe_key");
CREATE UNIQUE INDEX IF NOT EXISTS "certificates_token_key" ON "certificates" ("verification_token");
CREATE UNIQUE INDEX IF NOT EXISTS "certificates_public_id_key" ON "certificates" ("certificate_public_id");
CREATE INDEX IF NOT EXISTS "certificates_identity_idx" ON "certificates" ("customer_identity_id");

CREATE TABLE IF NOT EXISTS "achievements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "type" varchar(32) NOT NULL,
  "dedupe_key" varchar(200) NOT NULL,
  "is_public" boolean NOT NULL DEFAULT false,
  "meta" jsonb,
  "earned_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "achievements_dedupe_key" ON "achievements" ("organization_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "achievements_identity_idx" ON "achievements" ("customer_identity_id");
