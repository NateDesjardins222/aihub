-- Portal V2 Experience Layer — Progress & Achievements: customer-authored personal goals.
--
-- Authoritative server records owned by customer_identity_id (NOT localStorage).
-- A TRACKED goal completes automatically from the same authoritative aggregates
-- that drive payouts (lifetime paid trader-share, funded accounts, evaluations
-- passed), so completion cannot be forged. MANUAL goals are personal aims the
-- customer marks done themselves. Money targets are bigint micro-dollars.

CREATE TABLE IF NOT EXISTS "personal_goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "title" varchar(120) NOT NULL,
  "note" varchar(600),
  "kind" varchar(16) NOT NULL,
  "metric" varchar(32),
  "target_value" bigint,
  "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
  "pinned" boolean NOT NULL DEFAULT false,
  "completed_at" timestamptz,
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "personal_goals_identity_idx" ON "personal_goals" ("customer_identity_id");
CREATE INDEX IF NOT EXISTS "personal_goals_identity_status_idx" ON "personal_goals" ("customer_identity_id","status");
