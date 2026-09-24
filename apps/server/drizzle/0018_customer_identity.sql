-- Happy Trader Funding — Customer Identity + Whop Commerce + Automatic
-- Provisioning V1.
--
-- Additive and non-destructive. "Email is not the person": customer_identities
-- is the permanent spine beside `users`. Contact + identity verification and
-- versioned agreement acceptance gate an ungated purchase from provisioning.
-- commerce_events gives every inbound provider event a first-class authenticity
-- + dedup record. notification_messages is at-most-once, downstream of the
-- authoritative transaction. agreement_versions / agreement_acceptances are
-- append-only (triggers, mirroring auditLog / payout_ledger).
--
-- No real KYC/commerce/notification provider is wired; the mock/local adapters
-- are the working default and are never presented as production integrations.

-- --- commercial_orders: money-success vs provisioning-outcome states ---------
-- COMPLETED still means "money settled server-side". PROVISION_BLOCKED /
-- PROVISION_FAILED are the recoverable "PAYMENT SUCCEEDED / PROVISIONING FAILED"
-- states — the payment is retained, provisioning is deferred. Widen status so
-- 'PROVISION_BLOCKED' (17 chars) fits.
ALTER TABLE "commercial_orders" ALTER COLUMN "status" TYPE varchar(24);
ALTER TABLE "commercial_orders" ADD COLUMN IF NOT EXISTS "provision_note" text;
ALTER TABLE "commercial_orders" ADD COLUMN IF NOT EXISTS "refunded_at" timestamptz;
ALTER TABLE "commercial_orders" ADD COLUMN IF NOT EXISTS "refund_reason" text;

-- --- customer_identities: the permanent spine --------------------------------
CREATE TABLE IF NOT EXISTS "customer_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" varchar(24) NOT NULL DEFAULT 'ACTIVE',
  "legal_name" text,
  "date_of_birth" date,
  "country" varchar(2),
  "identity_status" varchar(24) NOT NULL DEFAULT 'UNVERIFIED',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "customer_identities_user_key" ON "customer_identities" ("user_id");
CREATE INDEX IF NOT EXISTS "customer_identities_org_idx" ON "customer_identities" ("organization_id");
CREATE INDEX IF NOT EXISTS "customer_identities_org_status_idx" ON "customer_identities" ("organization_id", "identity_status");

-- --- verified_contacts: proven reachable channels ----------------------------
CREATE TABLE IF NOT EXISTS "verified_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "channel" varchar(8) NOT NULL,
  "value" varchar(254) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "is_primary" boolean NOT NULL DEFAULT false,
  "verified_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "verified_contacts_identity_channel_value_key" ON "verified_contacts" ("customer_identity_id", "channel", "value");
CREATE INDEX IF NOT EXISTS "verified_contacts_identity_idx" ON "verified_contacts" ("customer_identity_id");
-- At most one primary per channel per identity.
CREATE UNIQUE INDEX IF NOT EXISTS "verified_contacts_primary_key" ON "verified_contacts" ("customer_identity_id", "channel") WHERE "is_primary";

-- --- contact_verification_challenges: short-lived proof ----------------------
CREATE TABLE IF NOT EXISTS "contact_verification_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "channel" varchar(8) NOT NULL,
  "value" varchar(254) NOT NULL,
  "code_hash" text NOT NULL,
  "salt" text NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "contact_challenges_identity_idx" ON "contact_verification_challenges" ("customer_identity_id", "channel", "status");

-- --- identity_verifications: KYC attempt records (decision, not documents) ----
CREATE TABLE IF NOT EXISTS "identity_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "provider" varchar(24) NOT NULL,
  "provider_ref" varchar(200),
  "status" varchar(24) NOT NULL,
  "reason_code" varchar(48),
  "legal_name" text,
  "date_of_birth" date,
  "address_json" jsonb,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "identity_verifications_identity_idx" ON "identity_verifications" ("customer_identity_id", "status");
CREATE INDEX IF NOT EXISTS "identity_verifications_org_status_idx" ON "identity_verifications" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "identity_verifications_provider_ref_idx" ON "identity_verifications" ("provider", "provider_ref");

-- --- agreement_versions: versioned terms (append-only) -----------------------
CREATE TABLE IF NOT EXISTS "agreement_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "agreement_type" varchar(32) NOT NULL,
  "version" integer NOT NULL,
  "title" varchar(120) NOT NULL,
  "body" text NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "is_required" boolean NOT NULL DEFAULT true,
  "requires_reacceptance" boolean NOT NULL DEFAULT false,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "agreement_versions_type_version_key" ON "agreement_versions" ("organization_id", "agreement_type", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "agreement_versions_type_hash_key" ON "agreement_versions" ("organization_id", "agreement_type", "content_hash");

-- Append-only: a material change publishes a new version, never edits an old one.
CREATE OR REPLACE FUNCTION "agreement_versions_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agreement_versions is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "agreement_versions_no_update" ON "agreement_versions";
CREATE TRIGGER "agreement_versions_no_update" BEFORE UPDATE OR DELETE ON "agreement_versions"
  FOR EACH ROW EXECUTE FUNCTION "agreement_versions_immutable"();

-- --- agreement_acceptances: immutable acceptance records (append-only) --------
CREATE TABLE IF NOT EXISTS "agreement_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "agreement_version_id" uuid NOT NULL REFERENCES "agreement_versions"("id"),
  "agreement_type" varchar(32) NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_meta" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "agreement_acceptances_identity_version_key" ON "agreement_acceptances" ("customer_identity_id", "agreement_version_id");
CREATE INDEX IF NOT EXISTS "agreement_acceptances_identity_idx" ON "agreement_acceptances" ("customer_identity_id");

-- A prior acceptance is never overwritten.
CREATE OR REPLACE FUNCTION "agreement_acceptances_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agreement_acceptances is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "agreement_acceptances_no_update" ON "agreement_acceptances";
CREATE TRIGGER "agreement_acceptances_no_update" BEFORE UPDATE OR DELETE ON "agreement_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "agreement_acceptances_immutable"();

-- --- commerce_events: authenticity + dedup ledger ----------------------------
CREATE TABLE IF NOT EXISTS "commerce_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "provider" varchar(16) NOT NULL,
  "provider_event_id" varchar(200) NOT NULL,
  "kind" varchar(24) NOT NULL,
  "atlas_order_id" uuid REFERENCES "commercial_orders"("id"),
  "status" varchar(16) NOT NULL DEFAULT 'RECEIVED',
  "signature_ok" boolean NOT NULL DEFAULT false,
  "reject_reason" varchar(48),
  "payload_digest" varchar(64),
  "amount_micros" bigint,
  "currency" varchar(8),
  "provider_customer_id" varchar(200),
  "receipt_id" varchar(200),
  "last_error" varchar(200),
  "occurred_at" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
-- The structural dedup: a replayed webhook is dropped before any provisioning.
CREATE UNIQUE INDEX IF NOT EXISTS "commerce_events_provider_event_key" ON "commerce_events" ("provider", "provider_event_id");
CREATE INDEX IF NOT EXISTS "commerce_events_org_status_idx" ON "commerce_events" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "commerce_events_order_idx" ON "commerce_events" ("atlas_order_id");

-- --- notification_messages: at-most-once customer notifications ---------------
CREATE TABLE IF NOT EXISTS "notification_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "type" varchar(40) NOT NULL,
  "channel" varchar(8) NOT NULL,
  "recipient" varchar(254) NOT NULL,
  "template_version" varchar(24) NOT NULL DEFAULT 'v1',
  "dedupe_key" varchar(200) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "terminal" boolean NOT NULL DEFAULT false,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 6,
  "provider" varchar(16),
  "provider_ref" varchar(200),
  "last_error" varchar(200),
  "payload" jsonb,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
-- At-most-once: a retried event never sends the same notification twice.
CREATE UNIQUE INDEX IF NOT EXISTS "notification_messages_dedupe_key" ON "notification_messages" ("organization_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "notification_messages_status_idx" ON "notification_messages" ("status", "channel");
CREATE INDEX IF NOT EXISTS "notification_messages_identity_idx" ON "notification_messages" ("customer_identity_id");
