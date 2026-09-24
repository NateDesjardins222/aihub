-- Milestone 6 — physical framed certificate orders (Prodigi merch).
-- Additive: one new table. Payment + fulfillment are server-authoritative; a
-- merch order never provisions a trading account. Production fulfillment is
-- disabled by default (see env PRODIGI_ENABLED / MERCH_ENABLED).

CREATE TABLE IF NOT EXISTS "physical_certificate_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "certificate_id" uuid NOT NULL REFERENCES "certificates"("id") ON DELETE RESTRICT,
  "sku" varchar(48) NOT NULL,
  "quantity" integer NOT NULL DEFAULT 1,
  "retail_amount_micros" bigint NOT NULL,
  "currency" varchar(3) NOT NULL DEFAULT 'USD',
  "status" varchar(24) NOT NULL DEFAULT 'PENDING_PAYMENT',
  "fulfillment_provider" varchar(16) NOT NULL DEFAULT 'MOCK',
  "provider_order_id" varchar(120),
  "provider_quote_amount_micros" bigint,
  "shipping_amount_micros" bigint,
  "estimated_contribution_micros" bigint,
  "shipping_address_snapshot" jsonb,
  "tracking_carrier" varchar(48),
  "tracking_number" varchar(120),
  "tracking_url" text,
  "failure_code" varchar(48),
  "failure_detail_safe" text,
  "idempotency_key" varchar(200),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "paid_at" timestamptz,
  "submitted_at" timestamptz,
  "shipped_at" timestamptz,
  "delivered_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "physical_cert_orders_identity_idx" ON "physical_certificate_orders" ("customer_identity_id");
CREATE INDEX IF NOT EXISTS "physical_cert_orders_org_status_idx" ON "physical_certificate_orders" ("organization_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "physical_cert_orders_provider_key" ON "physical_certificate_orders" ("fulfillment_provider", "provider_order_id");
