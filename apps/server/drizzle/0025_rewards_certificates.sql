-- Milestone 6 — Rewards & Certificates: deterministic rendered artifacts, reward
-- delivery tracking, and the manual 100K plaque fulfillment.
-- Additive and safe: new nullable columns on certificates (defaulted where NOT
-- NULL) + two new tables. No back-fill, no destructive change. Historical
-- certificate records keep their meaning; issued certificates are immutable.

ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "renderer_version" varchar(24);
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "render_status" varchar(16) NOT NULL DEFAULT 'PENDING';
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "image_storage_key" text;
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "print_storage_key" text;
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "pdf_storage_key" text;
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "render_hash" varchar(64);
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "render_error" text;
ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "milestone_value_micros" bigint;

CREATE TABLE IF NOT EXISTS "reward_delivery" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "certificate_id" uuid NOT NULL REFERENCES "certificates"("id") ON DELETE CASCADE,
  "in_app_delivered_at" timestamptz,
  "email_queued_at" timestamptz,
  "email_delivered_at" timestamptz,
  "last_delivery_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "reward_delivery_certificate_key" ON "reward_delivery" ("certificate_id");

CREATE TABLE IF NOT EXISTS "physical_reward_fulfillment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "certificate_id" uuid REFERENCES "certificates"("id") ON DELETE SET NULL,
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "type" varchar(24) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'PENDING_REVIEW',
  "shipping_address_status" varchar(24) NOT NULL DEFAULT 'NOT_PROVIDED',
  "fulfillment_notes" text,
  "tracking_carrier" varchar(48),
  "tracking_number" varchar(120),
  "shipped_at" timestamptz,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "physical_reward_customer_type_key" ON "physical_reward_fulfillment" ("organization_id", "customer_identity_id", "type");
CREATE INDEX IF NOT EXISTS "physical_reward_status_idx" ON "physical_reward_fulfillment" ("organization_id", "status");
